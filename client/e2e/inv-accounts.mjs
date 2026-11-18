// INVENTORY slice "accounts": account, friends, library, settings, storage/sync and platform rows.
// Each scenario drives the real UI (role/name locators) and asserts the row's "shows" column. Rows are grouped by the
// flow that reaches them; the `inv` list names every row a scenario proves.

import {
  ADMIN_PASSWORD,
  PASSWORD,
  builtinMaps,
  button,
  createRoom,
  dismissPhoneSplash,
  expectNoOverflow,
  ipIn,
  menuName,
  navTo,
  roomTitle,
  signedIn,
  signUp,
  sleep,
  uniqueName,
} from "./lib.mjs";

const check = (ok, message) => {
  if (!ok) throw new Error(message);
};

/**
 * Runs a scenario whose flow makes responses on purpose (wrong password, rate limit, injected failure).
 * Chromium logs each such response as a console error; drop only the listed statuses from the problems.
 */
function expectStatuses(statuses, run) {
  const re = new RegExp(`status of (${statuses.join("|")})\\b`);
  return async (s) => {
    try {
      return await run(s);
    } finally {
      for (const h of s.handles) h.problems = h.problems.filter((p) => !re.test(p));
    }
  };
}

const goMenu = async (page, base) => {
  await page.goto(base);
  await menuName(page).waitFor();
};
const openSettings = async (page, base) => {
  await goMenu(page, base);
  await navTo(page, "Settings");
};
const section = (page, label) => page.locator(".settings-nav-item", { hasText: label }).click();
const prefs = (page) => page.evaluate(() => JSON.parse(localStorage.getItem("neobox.prefs") || "null"));
const serverPrefs = async (page, base) => {
  const res = await page.request.get(`${base}/api/account/prefs`);
  return { status: res.status(), body: res.ok() ? await res.json() : null };
};
/** Waits until the server's copy of the prefs satisfies `pred` (saves are debounced). */
async function waitServerPrefs(page, base, pred, what) {
  const end = Date.now() + 8_000;
  for (;;) {
    const got = await serverPrefs(page, base);
    if (got.body && pred(got.body)) return got.body;
    if (Date.now() > end) throw new Error(`server prefs never matched: ${what} (last ${JSON.stringify(got).slice(0, 200)})`);
    await sleep(150);
  }
}
const menuAccount = (page) => page.getByRole("button", { name: /^(Sign in|Account, Level \d+)$/ }).first();
const accountForm = (page) => page.locator(".account-form");

// ---------------------------------------------------------------------------------------------------------------------
// Account: guest sign-in form and its errors; account creation and sign-out.

async function guestSignIn(s) {
  const h = await s.open("guest");
  const { page } = h;
  await goMenu(page, s.base);
  await check(await menuAccount(page).textContent().then((t) => t.trim() === "Sign in"), "guest menu account button is not Sign in");
  await menuAccount(page).click();
  await accountForm(page).getByLabel("name", { exact: true }).waitFor();
  check(await page.getByLabel("password", { exact: true }).isVisible(), "password field missing");
  check(await page.getByLabel("Stay signed in", { exact: true }).count(), "Stay signed in switch missing");
  check(await button(page, "Sign in").isVisible() && (await button(page, "Create account").isVisible()), "sign in / create account buttons missing");
  check(await button(page, "Privacy").isVisible(), "Privacy link missing on the sign-in form");

  await accountForm(page).getByLabel("name", { exact: true }).fill("okname");
  await button(page, "Create account").click();
  await page.getByText("Enter a password.", { exact: true }).waitFor();

  await accountForm(page).getByLabel("name", { exact: true }).fill("bad!name");
  await page.getByLabel("password", { exact: true }).fill(PASSWORD);
  await button(page, "Create account").click();
  await page.getByText("Names are 1 to 15 letters, numbers, spaces or _.", { exact: true }).waitFor();

  await accountForm(page).getByLabel("name", { exact: true }).fill(uniqueName("pw"));
  await page.getByLabel("password", { exact: true }).fill("short");
  await button(page, "Create account").click();
  await page.getByText("Passwords are 8 to 128 characters.", { exact: true }).waitFor();

  // the taken name belongs to another context, so this form stays a guest
  const taken = uniqueName("tk");
  const other = await s.open("owner");
  await signUp(other, s.base, taken);
  await accountForm(page).getByLabel("name", { exact: true }).fill(taken);
  await page.getByLabel("password", { exact: true }).fill(PASSWORD);
  await button(page, "Create account").click();
  await page.getByText("That name is taken", { exact: true }).waitFor();

  await page.getByLabel("password", { exact: true }).fill("wrongpassword1");
  await button(page, "Sign in").click();
  await page.getByText("Wrong name or password", { exact: true }).waitFor();
  return "guest form, empty password, bad name, short password, taken name, wrong password";
}

async function accountCreateAndSignOut(s) {
  const h = await s.open("maker");
  const { page } = h;
  const name = uniqueName("mk");
  await goMenu(page, s.base);
  await menuAccount(page).click();
  await accountForm(page).getByLabel("name", { exact: true }).fill(name);
  await page.getByLabel("password", { exact: true }).fill(PASSWORD);
  await button(page, "Create account").click();
  await page.getByText("Account created.", { exact: true }).waitFor();
  await goMenu(page, s.base);
  await page.getByRole("button", { name: /^Account, Level 1$/ }).waitFor();
  await page.getByRole("button", { name: /^Account, Level 1$/ }).click();
  for (const t of ["Level 1", "Joined", "Top maps", "Security", "Sign out", "0 friends"]) {
    await page.getByText(t, { exact: false }).first().waitFor();
  }
  await page.getByText("100 xp to level 2", { exact: true }).waitFor();
  await button(page, "Sign out").click();
  await page.getByText("Signed out.", { exact: true }).waitFor();
  return `created ${name}, account page, signed out`;
}

async function loginLimit(s) {
  const h = await s.open("limit", { ip: ipIn("203.0.113") });
  const { page } = h;
  const name = uniqueName("lim");
  // the account lives in its own context so the limited form stays a guest
  const owner = await s.open("owner");
  await signUp(owner, s.base, name);
  await goMenu(page, s.base);
  await menuAccount(page).click();
  await accountForm(page).getByLabel("name", { exact: true }).fill(name);
  await page.getByLabel("password", { exact: true }).fill("wrong-password-1");
  const statuses = [];
  for (let i = 0; i < 6; i++) {
    const [res] = await Promise.all([
      page.waitForResponse((r) => r.url().endsWith("/api/account/login")),
      button(page, "Sign in").click(),
    ]);
    statuses.push(res.status());
  }
  check(JSON.stringify(statuses) === "[401,401,401,401,401,429]", `sign-in statuses ${JSON.stringify(statuses)}`);
  await page.getByText("Too many attempts, wait a minute", { exact: false }).waitFor();
  return `statuses ${statuses.join(",")}`;
}

async function accountSecurity(s) {
  const h = await signedIn(s, "sec");
  const { page } = h;
  await goMenu(page, s.base);
  await page.getByRole("button", { name: /^Account, Level \d+$/ }).click();
  const security = page.locator("summary", { hasText: "Security" });
  await security.waitFor();
  // closed panel: the Change password button is not on screen until the panel opens
  check(!(await page.getByRole("button", { name: "Change password", exact: true }).isVisible()), "closed Security panel shows its body");
  await security.click();
  const changeBtn = page.getByRole("button", { name: "Change password", exact: true });
  await changeBtn.waitFor();
  check(await changeBtn.isVisible(), "Change password is not visible after the panel opens");

  await page.getByLabel("current password", { exact: true }).fill("wrongpassword1");
  await page.getByLabel("new password", { exact: true }).fill("brandnewpass1");
  await changeBtn.click();
  await page.getByText("current password is wrong", { exact: false }).waitFor();

  await page.getByLabel("current password", { exact: true }).fill(PASSWORD);
  await page.getByLabel("new password", { exact: true }).fill("short");
  await changeBtn.click();
  await page.getByText("Passwords are 8 to 128 characters.", { exact: true }).waitFor();

  await page.getByLabel("your name", { exact: true }).fill("not-my-name");
  await button(page, "Delete account").click();
  await page.getByText("Type your name", { exact: false }).waitFor();

  await page.getByLabel("your name", { exact: true }).fill(h.userName);
  await page.getByLabel("password", { exact: true }).last().fill("wrongpassword1");
  await button(page, "Delete account").click();
  await page.getByText(/password is wrong|wrong password/i).waitFor();
  check(await page.getByText(h.userName, { exact: false }).first().isVisible(), "account vanished after a wrong-password delete");
  return "security panel, wrong current password, short new password, delete with wrong name and wrong password";
}

// ---------------------------------------------------------------------------------------------------------------------
// Menu buttons: news, mute, fullscreen, clips.

async function menuButtons(s) {
  const h = await s.open("menu");
  const { page } = h;
  await goMenu(page, s.base);
  const dot = page.locator(".home-unread");
  check(await dot.isVisible(), "unread news dot not shown before opening News");
  await page.getByRole("button", { name: "News", exact: true }).click();
  const news = page.getByRole("dialog", { name: "Update news", exact: false });
  await news.waitFor();
  check(await news.getByText("1 of 6", { exact: false }).isVisible(), "news modal not paged 1 of 6");
  await news.getByRole("button", { name: "Next", exact: true }).click();
  await news.getByText("2 of 6", { exact: false }).waitFor();
  check(!(await dot.isVisible().catch(() => false)), "dot still shown while news is open");
  await page.keyboard.press("Escape");
  await news.waitFor({ state: "detached" }).catch(() => {});
  check(!(await dot.isVisible().catch(() => false)), "dot shown after closing news");
  check((await page.evaluate(() => localStorage.getItem("neobox.newsSeen"))) !== null, "newsSeen not stored");
  await navTo(page, "Settings");
  await page.getByRole("button", { name: "Back", exact: true }).click();
  check(!(await dot.isVisible().catch(() => false)), "dot shown again on return to the menu");

  await menuName(page).waitFor();
  await page.getByRole("button", { name: "Mute music", exact: true }).click();
  await page.getByRole("button", { name: "Unmute music", exact: true }).waitFor();
  check((await prefs(page))?.musicMuted === true, "musicMuted not stored after mute");
  await page.getByRole("button", { name: "Unmute music", exact: true }).click();
  await page.getByRole("button", { name: "Mute music", exact: true }).waitFor();
  check((await prefs(page))?.musicMuted === false, "musicMuted not restored after unmute");

  await page.getByRole("button", { name: /fullscreen/i }).first().click();
  check(await page.evaluate(() => document.fullscreenEnabled), "fullscreen not enabled");
  await page.waitForFunction(() => document.fullscreenElement !== null);

  await page.getByText(/recorded by neobox/).first().waitFor();
  check(await page.getByText("Simple Arena 1", { exact: false }).first().isVisible(), "clip name missing from the menu credit");
  return "news dot and modal, mute toggle, fullscreen, clip credit";
}

async function menuClipsFailure(s) {
  const h = await s.open("clipfail");
  const { page } = h;
  await page.route("**/api/clips**", (route) => route.fulfill({ status: 500, contentType: "application/json", body: '{"error":"boom"}' }));
  await Promise.all([page.waitForResponse((r) => r.url().includes("/api/clips")), goMenu(page, s.base)]);
  await sleep(300);
  const credit = page.getByText(/recorded by neobox/);
  check((await credit.count()) === 0 || !(await credit.first().isVisible()), "clip credit visible after a clip failure");
  check(!(await page.getByText("Simple Arena 1", { exact: false }).count()), "clip fallback text appeared");
  return "clip routes at 500: credit hidden, no fallback text";
}

// ---------------------------------------------------------------------------------------------------------------------
// Friends and profiles.

async function friendRow(page, name) {
  return page.locator("li.friend-row").filter({ hasText: name }).first();
}

async function friendsFlow(s) {
  const guest = await s.open("guestfr");
  await goMenu(guest.page, s.base);
  await navTo(guest.page, "Friends");
  await guest.page.getByText("Friends need an account. Sign in to add friends and see when they are online.", { exact: true }).waitFor();
  check(await button(guest.page, "Sign in").isVisible(), "friends signed-out Sign in button missing");

  const a = await signedIn(s, "alice");
  const b = await signedIn(s, "bobfr");
  const c = await signedIn(s, "carlfr");
  const ap = a.page;
  await navTo(ap, "Friends");
  await ap.getByText("No friends yet. Add one by name.", { exact: true }).waitFor();

  const input = ap.getByLabel("friend's name", { exact: true });
  await input.fill("bad!name");
  await button(ap, "Send request").click();
  await ap.getByText("Names are 1 to 15 letters, numbers, spaces or _.", { exact: true }).waitFor();
  await input.fill(a.userName);
  await button(ap, "Send request").click();
  await ap.getByText("You cannot befriend yourself", { exact: false }).waitFor();
  await input.fill("nobody_here_1");
  await button(ap, "Send request").click();
  await ap.getByText("No player has that name", { exact: false }).waitFor();

  await input.fill(b.userName);
  await button(ap, "Send request").click();
  await ap.getByText(`Request sent to ${b.userName}.`, { exact: true }).waitFor();
  await (await friendRow(ap, b.userName)).getByRole("button", { name: "Cancel request", exact: true }).click();
  await ap.locator("li.friend-row").filter({ hasText: b.userName }).waitFor({ state: "detached" });

  // requests: B accepts A's request, declines C's
  await input.fill(b.userName);
  await button(ap, "Send request").click();
  await ap.getByText(`Request sent to ${b.userName}.`, { exact: true }).waitFor();
  await c.page.goto(s.base);
  await navTo(c.page, "Friends");
  await c.page.getByLabel("friend's name", { exact: true }).fill(b.userName);
  await button(c.page, "Send request").click();
  await c.page.getByText(`Request sent to ${b.userName}.`, { exact: true }).waitFor();

  const bp = b.page;
  await navTo(bp, "Friends");
  await (await friendRow(bp, a.userName)).getByRole("button", { name: "Accept", exact: true }).click();
  await bp.getByText(`You are now friends with ${a.userName}.`, { exact: true }).waitFor();
  await (await friendRow(bp, c.userName)).getByRole("button", { name: "Decline", exact: true }).click();
  await bp.locator("li.friend-row").filter({ hasText: c.userName }).waitFor({ state: "detached" });

  // friend row opens the profile; profile shows the friend count
  await (await friendRow(bp, a.userName)).getByRole("button", { name: `${a.userName} profile`, exact: true }).click();
  const dialog = bp.getByRole("dialog").first();
  await dialog.getByText(a.userName, { exact: false }).first().waitFor();
  check(await dialog.getByText("1 friend", { exact: false }).isVisible(), "profile does not show 1 friend");
  await dialog.getByRole("button", { name: "Close", exact: true }).click();

  // join and remove: A enters a room with B, then removes B
  const roomName = uniqueName("frr");
  await createRoom(b, s.base, roomName, { isPublic: true });
  await ap.goto(s.base);
  await navTo(ap, "Friends");
  const inRoom = ap.locator("li.friend-row").filter({ hasText: b.userName }).filter({ hasText: `in ${roomName}` }).first();
  await inRoom.getByRole("button", { name: "Join", exact: true }).click();
  await roomTitle(ap, roomName).waitFor();
  await goMenu(ap, s.base);
  await navTo(ap, "Friends");
  await (await friendRow(ap, b.userName)).getByRole("button", { name: /^Remove/ }).click();
  await ap.locator("li.friend-row").filter({ hasText: b.userName }).waitFor({ state: "detached" });
  return "signed-out state, add errors, send/cancel, accept/decline, profile, join and remove";
}

async function profileStates(s) {
  const a = await signedIn(s, "pfa");
  const b = await signedIn(s, "pfb");
  const ap = a.page;
  // B asks A to be friends; A accepts, which gives the list row its profile button
  await navTo(b.page, "Friends");
  await b.page.getByLabel("friend's name", { exact: true }).fill(a.userName);
  await button(b.page, "Send request").click();
  await navTo(ap, "Friends");
  await (await friendRow(ap, b.userName)).getByRole("button", { name: "Accept", exact: true }).click();
  await ap.getByText(`You are now friends with ${b.userName}.`, { exact: true }).waitFor();
  const openProfile = async () => {
    await ap.goto(s.base);
    await menuName(ap).waitFor();
    await navTo(ap, "Friends");
    await (await friendRow(ap, b.userName)).waitFor();
    await ap.getByRole("button", { name: `${b.userName} profile`, exact: true }).click();
    return ap.getByRole("dialog").first();
  };

  // loading: hold the profile request until released
  let release;
  const gate = new Promise((r) => (release = r));
  await ap.route("**/api/players/**", async (route) => {
    await gate;
    await route.continue();
  });
  const loadingDialog = await openProfile();
  await loadingDialog.getByText("Loading profile…", { exact: true }).waitFor();
  release();
  await loadingDialog.getByRole("button", { name: "Close", exact: true }).click();
  await ap.unroute("**/api/players/**");

  // error, then Retry succeeds
  let failed = false;
  await ap.route("**/api/players/**", async (route) => {
    if (!failed) {
      failed = true;
      return route.fulfill({ status: 500, contentType: "application/json", body: '{"error":"boom"}' });
    }
    return route.continue();
  });
  const errDialog = await openProfile();
  await errDialog.getByText(`Couldn't load ${b.userName}`, { exact: false }).waitFor();
  await errDialog.getByRole("button", { name: "Retry", exact: true }).click();
  await errDialog.getByText("Level 1", { exact: false }).first().waitFor();
  await errDialog.getByRole("button", { name: "Close", exact: true }).click();
  await ap.unroute("**/api/players/**");

  // empty: a 404 means no profile
  await ap.route("**/api/players/**", (route) => route.fulfill({ status: 404, contentType: "application/json", body: '{"error":"not found"}' }));
  const emptyDialog = await openProfile();
  await emptyDialog.getByText(`No profile for ${b.userName}. Only signed-in players have one.`, { exact: false }).waitFor();
  await ap.unroute("**/api/players/**");
  return "profile loading, error then Retry, and 404 empty state";
}

// ---------------------------------------------------------------------------------------------------------------------
// Library.

async function libraryFlow(s) {
  const guest = await s.open("libguest");
  await goMenu(guest.page, s.base);
  await navTo(guest.page, "Library");
  await button(guest.page, "Mine").or(guest.page.getByRole("tab", { name: "Mine", exact: true })).first().click();
  await guest.page.getByText("Sign in to see and upload your maps.", { exact: true }).waitFor();
  await button(guest.page, "Favourites").or(guest.page.getByRole("tab", { name: "Favourites", exact: true })).first().click();
  await guest.page.getByText("Sign in to see your favourite maps.", { exact: true }).waitFor();

  const user = await signedIn(s, "libmk");
  const { page } = user;
  const maps = await builtinMaps(s.base);
  const map = maps[0];
  const name = uniqueName("lib");
  await navTo(page, "Library");
  await button(page, "Mine").or(page.getByRole("tab", { name: "Mine", exact: true })).first().click();
  await page.getByText("No maps yet. Upload one; it shows in Browse once an admin approves it.", { exact: false }).waitFor();
  await button(page, "Favourites").or(page.getByRole("tab", { name: "Favourites", exact: true })).first().click();
  await page.getByText("No favourites yet. Star a map to keep it here.", { exact: false }).waitFor();
  await button(page, "Mine").or(page.getByRole("tab", { name: "Mine", exact: true })).first().click();

  await button(page, "Upload a map").click();
  await button(page, "Upload map").click();
  await page.getByText("Give the map a name and paste its code.", { exact: true }).waitFor();
  await page.getByPlaceholder("Map name", { exact: true }).fill(name);
  await page.getByLabel("map code", { exact: true }).fill(map.code);
  await page.getByRole("radiogroup", { name: "Visibility", exact: true }).getByRole("radio", { name: "Public", exact: true }).click();
  await button(page, "Upload map").click();
  const pending = page.locator("ul[aria-label=maps] li").filter({ hasText: name });
  await pending.waitFor();
  check(await pending.getByText("Awaiting approval", { exact: false }).isVisible(), "pending card lacks Awaiting approval");

  const admin = await s.open("admin");
  await admin.page.goto(`${s.base}/admin`);
  await admin.page.locator("#pw").fill(ADMIN_PASSWORD);
  await button(admin.page, "Log in").click();
  await admin.page.getByRole("heading", { name: "Map approvals" }).waitFor();
  await admin.page.locator("table#maps tbody tr").filter({ hasText: name }).getByRole("button", { name: "Approve", exact: true }).click();
  await admin.page.getByText(`Approved ${name}.`, { exact: false }).waitFor();

  const visitor = await s.open("visitor", { clipboard: s.env.browser.clipboard });
  const vp = visitor.page;
  await goMenu(vp, s.base);
  await navTo(vp, "Library");
  await button(vp, "Browse").or(vp.getByRole("tab", { name: "Browse", exact: true })).first().click();
  const card = vp.locator("ul[aria-label=maps] li").filter({ hasText: name }).first();
  await card.locator(".map-card").click();
  const dlg = vp.getByRole("dialog", { name, exact: true });
  await dlg.waitFor();
  await dlg.getByRole("button", { name: "Star", exact: true }).click();
  await vp.getByText("Sign in to star maps.", { exact: true }).waitFor();
  await dlg.getByRole("button", { name: "Copy code", exact: true }).click();
  await vp.getByText("Map code copied.", { exact: true }).waitFor();
  await dlg.getByRole("button", { name: "Report map", exact: true }).click();
  const report = vp.getByRole("dialog", { name: /Report/ }).first();
  for (const reason of ["Offensive", "Broken", "Stolen", "Other"]) {
    check(await report.getByRole("radio", { name: reason, exact: true }).count(), `report reason ${reason} missing`);
  }
  await report.getByRole("radio", { name: "Broken", exact: true }).check();
  await report.getByRole("button", { name: /^Send|^Report/ }).last().click();
  await vp.getByText("Thanks. An admin will look at this map.", { exact: true }).waitFor();

  // owner: save with no edits, save with a description edit, then delete
  await goMenu(page, s.base);
  await navTo(page, "Library");
  await button(page, "Mine").or(page.getByRole("tab", { name: "Mine", exact: true })).first().click();
  const own = page.locator("ul[aria-label=maps] li").filter({ hasText: name }).first();
  await own.locator(".map-card").click();
  const ownDlg = page.getByRole("dialog", { name, exact: true });
  await ownDlg.waitFor();
  await ownDlg.getByText("Edit your map", { exact: true }).click();
  await ownDlg.getByRole("button", { name: "Save changes", exact: true }).click();
  await page.getByText("No changes to save.", { exact: true }).waitFor();
  await ownDlg.getByLabel("Description", { exact: true }).fill(`${name} edited`);
  await ownDlg.getByRole("button", { name: "Save changes", exact: true }).click();
  await page.getByText("Map saved.", { exact: true }).waitFor();
  await ownDlg.getByRole("button", { name: "Delete map", exact: true }).click();
  const confirmDlg = page.getByRole("alertdialog");
  await confirmDlg.getByRole("button", { name: "Delete map", exact: true }).click();
  await page.getByText("Map deleted.", { exact: true }).waitFor();
  return `signed-out gates, empty states, upload, admin approve, star/copy/report, save/delete (map ${map.code.length} chars)`;
}

async function libraryLoading(s) {
  const h = await s.open("libload");
  const { page } = h;
  let release;
  const gate = new Promise((r) => (release = r));
  await page.route("**/api/library?**", async (route) => {
    await gate;
    await route.continue();
  });
  const response = page.waitForResponse((r) => r.url().includes("/api/library"));
  await goMenu(page, s.base);
  await navTo(page, "Library");
  await page.getByText("Loading", { exact: false }).first().waitFor();
  release();
  await response;
  await page.unroute("**/api/library?**");
  return "library list held: Loading shown until released";
}

// ---------------------------------------------------------------------------------------------------------------------
// Settings: controls, touch, sound, display, chat, account link, reset.

async function settingsControls(s) {
  const h = await s.open("controls");
  const { page } = h;
  await openSettings(page, s.base);
  for (const t of ["Controls", "Touch", "Sound", "Display", "Accessibility", "Chat"]) {
    check(await page.locator(".settings-nav-item", { hasText: t }).count(), `settings nav ${t} missing`);
  }
  await page.getByText("Gamepad (fixed)", { exact: false }).first().waitFor();
  check(await page.getByRole("button", { name: /^Jump key/ }).count(), "key rows missing");

  // rebind and persist
  await page.getByRole("button", { name: /^Jump key/ }).first().click();
  await page.getByText(/Press a key for Jump/).waitFor();
  await page.keyboard.press("KeyK");
  await page.getByRole("button", { name: /^Jump key 1: K\. Change/ }).waitFor();
  await page.reload();
  await menuName(page).waitFor();
  await navTo(page, "Settings");
  check(await page.getByRole("button", { name: /^Jump key 1: K\. Change/ }).count(), "rebound key did not survive reload");
  check(JSON.stringify((await prefs(page)).keys.up).includes("KeyK"), "keys.up lacks KeyK");

  // reserved keys: each is refused with its own notice, and the capture ends
  for (const k of ["Tab", "Enter", "F3"]) {
    await page.getByRole("button", { name: /^Jump key/ }).first().click();
    await page.getByText(/Press a key for Jump/).waitFor();
    await page.keyboard.press(k);
    await page.getByText(`${k} is used by the game or browser. Pick another key.`, { exact: true }).waitFor();
  }

  // conflict: a key already bound to Left
  await page.getByRole("button", { name: /^Jump key/ }).first().click();
  await page.getByText(/Press a key for Jump/).waitFor();
  await page.keyboard.press("ArrowLeft");
  await page.getByText(/is already used for Left\. Move it to Jump\?/).waitFor();
  await page.keyboard.press("Escape");
  await page.getByText(/Press a key for Jump/).waitFor({ state: "detached" });

  // cancel: Escape ends the capture with the binding unchanged
  const before = JSON.stringify((await prefs(page)).keys.up);
  await page.getByRole("button", { name: /^Jump key/ }).first().click();
  await page.getByText(/Press a key for Jump/).waitFor();
  await page.keyboard.press("Escape");
  await page.getByText(/Press a key for Jump/).waitFor({ state: "detached" });
  check(JSON.stringify((await prefs(page)).keys.up) === before, "Escape changed the binding");

  // max three: Left takes keys until it has three, and its Add key button then goes away
  const leftRow = page.locator(".bind-row").filter({ has: page.locator(".bind-label", { hasText: /^Left$/ }) });
  for (const k of ["KeyP", "KeyO", "KeyY"]) {
    if ((await prefs(page)).keys.left.length === 3) break;
    await leftRow.getByRole("button", { name: /^Add key/ }).click();
    await page.getByText("Press a key for Left.", { exact: false }).waitFor();
    await page.keyboard.press(k);
  }
  check((await prefs(page)).keys.left.length === 3, "Left did not reach three keys");
  check((await leftRow.getByRole("button", { name: /^Add key/ }).count()) === 0, "Add key still shown for a full Left");
  return "settings nav, rebind, reserved keys, conflict, cancel, max three, gamepad fixed";
}

async function settingsReset(s) {
  const h = await s.open("reset");
  const { page } = h;
  await openSettings(page, s.base);
  await section(page, "Sound");
  await page.getByRole("slider", { name: "Volume", exact: true }).fill("30");
  await section(page, "Chat");
  await button(page, "Reset to defaults").click();
  const dlg = page.getByRole("dialog", { name: /Reset settings/ });
  await dlg.waitFor();
  await dlg.getByRole("button", { name: "Cancel", exact: true }).click();
  await dlg.waitFor({ state: "detached" });
  check((await prefs(page)).volume === 0.3, "Cancel changed the volume");
  await button(page, "Reset to defaults").click();
  await page.getByRole("dialog", { name: /Reset settings/ }).getByRole("button", { name: "Reset everything", exact: true }).click();
  await page.getByText("Settings reset to the defaults.", { exact: true }).waitFor();
  check((await prefs(page)).volume === 0.6, "reset did not restore the default volume");
  return "reset cancel keeps values, confirm restores defaults";
}

async function settingsPrefs(s) {
  const h = await s.open("prefs");
  const { page } = h;
  await openSettings(page, s.base);

  await section(page, "Touch");
  await page.getByText("The on-screen controls on phones and tablets.", { exact: true }).waitFor();
  const size = page.getByRole("slider", { name: "Control size", exact: true }).first();
  check((await size.getAttribute("min")) === "70" && (await size.getAttribute("max")) === "150", "control size range is not 70-150");
  await size.fill("130");
  await page.getByRole("switch", { name: /^Left-handed layout/ }).click();
  check((await prefs(page)).touchLeftHanded === true, "touchLeftHanded not stored");
  check(Math.abs((await prefs(page)).touchScale - 1.3) < 0.001, "touchScale not stored as 1.3");

  await section(page, "Sound");
  await page.getByRole("slider", { name: "Volume", exact: true }).fill("30");
  await page.getByRole("slider", { name: "Music volume", exact: true }).fill("40");
  await page.getByRole("slider", { name: "Effects volume", exact: true }).fill("50");
  await page.getByRole("slider", { name: "Jukebox volume", exact: true }).fill("20");
  const p1 = await prefs(page);
  check(p1.volume === 0.3 && p1.musicVolume === 0.4 && p1.sfxVolume === 0.5 && p1.jukeboxVolume === 0.2, "sound sliders not stored");
  await page.getByRole("switch", { name: /^Mute menu music/ }).click();
  await page.getByRole("switch", { name: /^Mute match music/ }).click();
  await page.getByRole("switch", { name: /^Interface sounds/ }).click();
  await page.getByRole("switch", { name: /^Mute all sound/ }).click();
  const p2 = await prefs(page);
  check(p2.musicMuted === true && p2.matchMusicMuted === true && p2.uiSounds === false && p2.muted === true, "sound switches not stored");
  await page.getByRole("switch", { name: /^Mute all sound/ }).click();

  await section(page, "Display");
  await page.getByRole("radiogroup", { name: "Theme", exact: true }).getByRole("radio", { name: "Dark", exact: true }).check();
  check((await prefs(page)).theme === "dark", "theme not stored as dark");
  await page.getByRole("slider", { name: "Render scale", exact: true }).fill("50");
  check((await prefs(page)).renderScale === 0.5, "renderScale not stored as 0.5");
  await page.getByRole("switch", { name: /^Anti-aliasing/ }).click();
  check((await prefs(page)).antialias === false, "antialias not stored as false");
  await page.getByRole("switch", { name: /^Show stats/ }).click();
  check((await prefs(page)).showStats === true, "showStats not stored");
  await page.getByLabel("Deuteranopia (green-blind)", { exact: false }).check();
  check((await prefs(page)).palette === "deuteranopia", "palette not stored");

  await page.getByRole("button", { name: "Choose colour", exact: true }).click();
  const grp = page.getByRole("radiogroup", { name: "Colour", exact: true });
  await grp.getByRole("radio", { name: "Red", exact: true }).click();
  await button(page, "Save colour").click();
  await grp.waitFor({ state: "detached" }); // the closing picker must leave the DOM before a reopen
  check((await prefs(page)).color === 15022389, "colour Red (#E53935) not stored");
  await page.getByRole("button", { name: "Choose colour", exact: true }).click();
  await grp.getByRole("radio", { name: "Red", exact: true }).focus();
  await page.keyboard.press("ArrowRight");
  check((await grp.getByRole("radio", { name: "Orange", exact: true }).getAttribute("aria-checked")) === "true", "ArrowRight did not move to Orange");
  await page.keyboard.press("Enter");
  await button(page, "Save colour").click();
  check((await prefs(page)).color === 16740419, "colour Orange (#FF7043) not stored from the keyboard");
  await page.getByRole("button", { name: "Automatic", exact: true }).click();
  check((await prefs(page)).color === null, "Automatic did not clear the colour");

  await section(page, "Chat");
  await page.getByRole("switch", { name: /^Filter profanity/ }).click();
  check((await prefs(page)).filterProfanity === false, "filterProfanity not stored as false");
  return "touch size and left-handed, sound levels and switches, theme, scale, AA, stats, palette, colour picker keys, profanity filter";
}

async function settingsAccountLink(s) {
  const h = await s.open("acctlink");
  await openSettings(h.page, s.base);
  await button(h.page, "Account").click();
  await accountForm(h.page).getByLabel("name", { exact: true }).waitFor();
  return "settings Account button opens the sign-in form for guests";
}

// ---------------------------------------------------------------------------------------------------------------------
// Storage and sync.

async function storageAndSync(s) {
  const g = await s.open("store");
  const gp = g.page;
  await goMenu(gp, s.base);
  await menuAccount(gp).click();
  await gp.getByLabel("Stay signed in", { exact: true }).click();
  const name = uniqueName("stay");
  await accountForm(gp).getByLabel("name", { exact: true }).fill(name);
  await gp.getByLabel("password", { exact: true }).fill(PASSWORD);
  await button(gp, "Create account").click();
  await gp.getByText("Account created.", { exact: true }).waitFor();
  await gp.waitForFunction(() => localStorage.getItem("neobox.staySignedIn") === "1");

  // a second context signs in with the switch left off: the choice is stored at sign-in
  const off = await s.open("stayoff");
  await goMenu(off.page, s.base);
  await menuAccount(off.page).click();
  await accountForm(off.page).getByLabel("name", { exact: true }).fill(name);
  await off.page.getByLabel("password", { exact: true }).fill(PASSWORD);
  await button(off.page, "Sign in").click();
  await off.page.waitForFunction(() => localStorage.getItem("neobox.staySignedIn") === "0");
  await goMenu(gp, s.base);

  await openSettings(gp, s.base);
  await gp.getByRole("slider", { name: "Volume", exact: true }).fill("30");
  const ss = await gp.evaluate(() => sessionStorage.length);
  const lsKeys = await gp.evaluate(() => Object.keys(localStorage));
  check(ss === 0, "guest sessionStorage is not empty");
  check(lsKeys.includes("neobox.prefs") && lsKeys.every((k) => k.startsWith("neobox.")), `guest localStorage keys ${lsKeys}`);
  await gp.reload();
  await menuName(gp).waitFor();
  await navTo(gp, "Settings");
  check((await gp.getByRole("slider", { name: "Volume", exact: true }).inputValue()) === "30", "volume 30 did not survive reload");
  check((await prefs(gp)).volume === 0.3, "prefs volume not 0.3 after reload");

  // privacy notice lists the local keys the client writes
  await goMenu(gp, s.base);
  await gp.getByRole("button", { name: "Privacy", exact: true }).click();
  const priv = await gp.locator("body").innerText();
  check(priv.includes("the phone welcome") && priv.includes("Training badge"), "privacy notice does not list phoneSplashSeen/hintSeen");

  // signed-in sync
  const a = await signedIn(s, "sync");
  const ap = a.page;
  await openSettings(ap, s.base);
  let put = ap.waitForResponse((r) => r.url().endsWith("/api/account/prefs") && r.request().method() === "PUT");
  await ap.getByRole("slider", { name: "Volume", exact: true }).fill("60");
  await put;
  await waitServerPrefs(ap, s.base, (b) => Math.abs(b.volume - 0.6) < 0.001, "volume 0.6");

  await ap.getByRole("slider", { name: "Volume", exact: true }).fill("35");
  await ap.evaluate(() => window.dispatchEvent(new Event("pagehide")));
  await waitServerPrefs(ap, s.base, (b) => Math.abs(b.volume - 0.35) < 0.001, "volume 0.35 after pagehide");

  // save failure surfaces a toast
  await ap.route("**/api/account/prefs", (route) =>
    route.request().method() === "PUT" ? route.fulfill({ status: 500, contentType: "application/json", body: '{"error":"boom"}' }) : route.continue(),
  );
  await ap.getByRole("slider", { name: "Volume", exact: true }).fill("20");
  await ap.getByText("settings not saved to your account: boom", { exact: false }).waitFor({ timeout: 8_000 });
  await ap.unroute("**/api/account/prefs");

  // sign out: server prefs are refused, the device copy stays
  await goMenu(ap, s.base);
  await page_signOut(ap);
  await ap.getByText("Signed out.", { exact: true }).waitFor();
  await sleep(300);
  const after = await ap.request.get(`${s.base}/api/account/prefs`);
  check(after.status() === 401, `prefs after sign-out is ${after.status()}, expected 401`);
  check((await prefs(ap)) !== null, "device prefs removed at sign-out");
  return "stay-signed-in stored at create and sign-in, guest keys, reload, privacy list, sync, pagehide, save toast, sign-out";
}

async function page_signOut(page) {
  await page.getByRole("button", { name: /^Account, Level \d+$/ }).click();
  await button(page, "Sign out").click();
}

// ---------------------------------------------------------------------------------------------------------------------
// Platform: colour scheme, motion, coarse pointer, CSS breakpoints, overflow matrix.

async function platform(s) {
  const dark = await s.open("dark");
  await dark.page.emulateMedia({ colorScheme: "dark" });
  await goMenu(dark.page, s.base);
  check((await dark.page.evaluate(() => getComputedStyle(document.body).backgroundColor)) === "rgb(10, 10, 10)", "dark body background is not rgb(10,10,10)");
  await navTo(dark.page, "Settings");
  check((await dark.page.evaluate(() => matchMedia("(prefers-color-scheme: dark)").matches)) === true, "dark not matched");

  const motion = await s.open("motion");
  await motion.page.emulateMedia({ reducedMotion: "reduce" });
  await goMenu(motion.page, s.base);
  check((await motion.page.evaluate(() => matchMedia("(prefers-reduced-motion: reduce)").matches)) === true, "reduced motion not matched");

  const phone = await s.open("phone", { phone: true });
  await phone.page.goto(s.base);
  await dismissPhoneSplash(phone.page);
  await menuName(phone.page).waitFor();
  const coarse = await phone.page.evaluate(() => ({
    coarse: matchMedia("(pointer: coarse)").matches,
    hover: matchMedia("(hover: none)").matches,
    touch: navigator.maxTouchPoints,
    css: matchMedia("(pointer: coarse)").matches,
  }));
  // Only Chromium exposes maxTouchPoints under hasTouch; Firefox and WebKit do not. The pointer and hover queries above apply everywhere.
  const reportsTouch = s.env.browser.browserType().name() === "chromium";
  check(coarse.coarse && coarse.hover && (!reportsTouch || coarse.touch >= 1), `touch capable ${JSON.stringify(coarse)}`);

  const desk = await s.open("desk");
  await goMenu(desk.page, s.base);
  check((await desk.page.evaluate(() => matchMedia("(pointer: coarse)").matches)) === false, "desktop context reports coarse pointer");

  // coarse-pointer targets: every visible control on the menu and Settings is at least 44 px
  const targets = () =>
    phone.page.evaluate(() =>
      [...document.querySelectorAll("button,[role=button],[role=switch],input[type=range],[role=radio]")]
        .filter((e) => e.getClientRects().length)
        .map((e) => {
          const r = e.getBoundingClientRect();
          return { n: (e.getAttribute("aria-label") || e.textContent || "").trim().replace(/\s+/g, " ").slice(0, 40), w: Math.round(r.width), h: Math.round(r.height) };
        })
        .filter((x) => x.w < 44 || x.h < 44),
    );
  const menuSmall = await targets();
  check(menuSmall.length === 0, `menu controls under 44px on a coarse pointer: ${JSON.stringify(menuSmall.slice(0, 6))}`);
  await navTo(phone.page, "Settings");
  const setSmall = await targets();
  check(setSmall.length === 0, `settings controls under 44px on a coarse pointer: ${JSON.stringify(setSmall.slice(0, 6))}`);
  await expectNoOverflow(phone.page, "phone settings");
  return "dark, reduced motion, touch capable, coarse targets";
}

async function platformMatrix(s) {
  const sizes = [
    { w: 390, h: 844, phone: false, at600: true, at900: true, landscape: false },
    { w: 844, h: 390, phone: false, at600: false, at900: true, landscape: true },
    { w: 320, h: 568, phone: false, at600: true, at900: true, landscape: false },
    { w: 768, h: 1024, phone: false, at600: false, at900: true, landscape: false },
    { w: 1280, h: 800, phone: false, at600: false, at900: false, landscape: true },
    { w: 3440, h: 1440, phone: false, at600: false, at900: false, landscape: true },
    { w: 2560, h: 1440, phone: false, at600: false, at900: false, landscape: true },
  ];
  for (const z of sizes) {
    const h = await s.open(`m${z.w}x${z.h}`, { viewport: { width: z.w, height: z.h } });
    await goMenu(h.page, s.base);
    const css = await h.page.evaluate(() => ({
      a600: matchMedia("(max-width: 600px)").matches,
      a900: matchMedia("(max-width: 900px)").matches,
      land: matchMedia("(orientation: landscape)").matches,
    }));
    const label = `${z.w}x${z.h}`;
    check(css.a600 === z.at600, `${label} @600 is ${css.a600}`);
    check(css.a900 === z.at900, `${label} @900 is ${css.a900}`);
    check(css.land === z.landscape, `${label} landscape is ${css.land}`);
    await expectNoOverflow(h.page, `menu ${label}`);
    await navTo(h.page, "Settings");
    await expectNoOverflow(h.page, `settings ${label}`);
  }
  return "7 viewports: @600, @900, landscape and no horizontal overflow on menu and Settings";
}

// ---------------------------------------------------------------------------------------------------------------------
// About and privacy.

async function aboutAndPrivacy(s) {
  const h = await s.open("about");
  const { page } = h;
  await goMenu(page, s.base);
  await navTo(page, "About");
  await page.getByText("About neobox", { exact: true }).waitFor();
  check(await page.getByText("GNU Affero General Public License", { exact: false }).isVisible(), "AGPL text missing");
  check(await page.getByRole("link", { name: "Source code", exact: true }).first().isVisible(), "source link missing");
  check(await page.getByText("Electronic music / chiptune 3", { exact: false }).first().isVisible(), "chiptune credit missing");
  check(await page.getByRole("link", { name: "Source page", exact: true }).evaluateAll((as) => as.some((a) => a.href.includes("opengameart.org"))), "OpenGameArt source link missing");
  check(await page.getByText("CC0", { exact: false }).first().isVisible(), "CC0 licence missing");
  await button(page, "News").click();
  const news = page.getByRole("dialog", { name: "Update news", exact: false });
  await news.waitFor();
  await page.keyboard.press("Escape");
  await news.waitFor({ state: "detached" }).catch(() => {});

  await goMenu(page, s.base);
  await page.getByRole("button", { name: "Privacy", exact: true }).click();
  await page.getByRole("heading", { name: "Sessions and cookies" }).waitFor();
  const text = await page.locator("body").innerText();
  check(text.includes("nb_session") && text.includes("HttpOnly") && text.includes("SameSite=Lax"), "cookie text missing");
  check(text.includes("30 days") && text.includes("20 sessions"), "session lifetime or cap missing");
  check(text.includes("Data kept in your browser"), "local data section missing");
  return "about text and links, about news link, privacy sections";
}

export const accountsInvScenarios = [
  { name: "inv accounts guest sign-in", inv: ["account-signed-out", "menu-account-btn", "acct-empty-password", "acct-name-bad", "acct-pw-short", "acct-taken", "acct-login-wrong-password"], run: expectStatuses([400, 401, 409], guestSignIn) },
  { name: "inv accounts create and sign out", inv: ["account-create", "account-signed-in", "account-signout"], run: accountCreateAndSignOut },
  { name: "inv accounts login limit", inv: ["acct-login-limit"], run: expectStatuses([401, 429], loginLimit) },
  { name: "inv accounts security and delete", inv: ["acct-pw-wrong-change", "acct-pw-short-change", "acct-change-password-collapsed", "acct-delete-wrong", "acct-delete-wrong-password"], run: expectStatuses([400, 401, 403], accountSecurity) },
  { name: "inv accounts menu buttons", inv: ["menu-news-btn", "news-modal", "menu-mute-btn", "menu-fullscreen-btn", "menu-clips"], run: menuButtons },
  { name: "inv accounts clips failure", inv: ["menu-clips-failure"], run: expectStatuses([500], menuClipsFailure) },
  { name: "inv accounts friends", inv: ["friends-signed-out", "friends-signed-in", "friends-add-errors", "friends-send-request-and-cancel", "friends-requests-accept-decline", "friends-list-and-profile", "friends-join-and-remove"], run: expectStatuses([400, 404, 409], friendsFlow) },
  { name: "inv accounts profile states", inv: ["profile-modal", "profile-modal-loading", "profile-modal-error", "profile-modal-empty"], run: expectStatuses([404, 500], profileStates) },
  { name: "inv accounts library", inv: ["library-page", "library-upload-signed-out-gate", "library-tabs-mine-empty", "library-upload", "library-toasts", "library-upload-validation-and-toasts", "library-admin-approve", "library-star-guest", "library-copy-code", "library-owner-save-and-delete", "library-report"], run: libraryFlow },
  { name: "inv accounts library loading", inv: ["library-loading-state"], run: libraryLoading },
  { name: "inv accounts settings controls", inv: ["settings-page", "settings-controls", "set-controls-rebind-persist", "set-controls-reserved-key", "set-controls-conflict", "set-controls-cancel-capture", "set-controls-max-three", "settings-gamepad-fixed"], run: settingsControls },
  { name: "inv accounts settings reset", inv: ["settings-reset", "set-reset"], run: settingsReset },
  { name: "inv accounts settings prefs", inv: ["settings-touch", "set-touch-size", "set-touch-left", "settings-sound", "snd-volume", "snd-music-volume", "snd-sfx-volume", "snd-jukebox-volume", "snd-mute-all", "snd-mute-menu-music", "snd-mute-match-music", "snd-ui-sounds", "settings-display", "set-theme", "set-render-scale", "set-antialias", "set-show-stats", "set-palette", "set-color-choose", "set-color-auto", "color-picker-keys", "settings-chat", "set-filter-profanity"], run: settingsPrefs },
  { name: "inv accounts settings account link", inv: ["set-account-link"], run: settingsAccountLink },
  { name: "inv accounts storage and sync", inv: ["store-staysignedin", "store-guest-keys", "store-prefs-reload", "store-privacy-gap", "sync-prefs", "sync-pagehide", "sync-signout", "acct-prefs-toast"], run: expectStatuses([500], storageAndSync) },
  { name: "inv accounts platform", inv: ["plat-dark", "plat-reduced-motion", "plat-touch-capable", "plat-coarse-buttons", "plat-css-coarse"], run: platform },
  { name: "inv accounts platform matrix", inv: ["plat-css-600", "plat-css-900", "plat-css-landscape"], run: platformMatrix },
  { name: "inv accounts about and privacy", inv: ["about-page", "about-news-link", "privacy-page"], run: aboutAndPrivacy },
];
