// Screen changes start on the click. The menu's Browse and a room row's join start the screen change at once, at any
// round-trip time, with the list or the room pending until the server answers. Errors come back to Browse: a list that
// cannot load (Try again), a full room, a wrong password. Cancel and Back abandon a pending join.
// Each RTT case delays every message both ways through the relay (liveness.mjs linked()). The clock is the page's own:
// a capture listener stamps the click, and the first screen-in animationstart after it stamps the animation.

import { PASSWORD, button, menuName, navTo, playFromMenu, roomTitle, sleep, uniqueName } from "./lib.mjs";
import { linked } from "./liveness.mjs";

const check = (ok, message) => {
  if (!ok) throw new Error(message);
};

/** Click to the screen-in animation's first frame. */
const START_MS = 50;
/** Round trips: the link's RTT, each direction half of it. */
const RTTS = [0, 150, 400];
const WAIT_MS = 10_000;

/** Stamps the last click and the first screen-in animation after it, with what the page shows at that moment. */
const CLICK_SPY = () => {
  const fresh = () => ({ clickAt: null, animAt: null, skel: false, joining: false });
  window.__tr = fresh();
  document.addEventListener(
    "click",
    () => {
      window.__tr = { ...fresh(), clickAt: performance.now() };
    },
    true,
  );
  document.addEventListener(
    "animationstart",
    (e) => {
      const t = window.__tr;
      if (e.animationName !== "screen-in" || t.clickAt === null || t.animAt !== null) return;
      t.animAt = performance.now();
      t.skel = document.querySelector(".room-skeleton") !== null;
      t.joining = document.querySelector(".room-joining:not([hidden])") !== null;
    },
    true,
  );
};

async function open(s, label, opts) {
  const h = await s.open(label, opts);
  await h.context.addInitScript(CLICK_SPY);
  return h;
}

/** Sets the round trip the relay applies to this page's messages. */
const setRtt = (h, rtt) => {
  h.link.cond = rtt > 0 ? { rtt, jitter: 0, loss: 0 } : null;
};

const browseHeading = (page) => page.getByRole("heading", { name: "Browse rooms", exact: true });
const roomRow = (page, roomName) =>
  page.locator('ul[aria-label="rooms"] li.room-item').filter({ has: page.locator("button.room-row", { hasText: roomName }) });
const retryButton = (page) => page.locator(".room-error").getByRole("button", { name: "Try again", exact: true });
const joining = (page) => page.locator(".room-joining");

/** Runs `act` (the click) and returns the page's clock once the screen-in animation has started. */
async function clickToScreen(page, act, label) {
  await act();
  try {
    await page.waitForFunction(() => window.__tr.animAt !== null, undefined, { timeout: WAIT_MS });
  } catch {
    throw new Error(`${label}: no screen-in animation within ${WAIT_MS} ms of the click`);
  }
  const t = await page.evaluate(() => window.__tr);
  const ms = t.animAt - t.clickAt;
  check(ms < START_MS, `${label}: the screen change started ${ms.toFixed(0)} ms after the click (budget ${START_MS} ms)`);
  return { ms, skel: t.skel, joining: t.joining };
}

/** The menu, then Browse; the list is loaded when this returns. */
async function goBrowse(page, base) {
  await page.goto(base);
  await menuName(page).waitFor();
  await navTo(page, "Browse rooms");
  await browseHeading(page).waitFor();
  await page.locator(".room-skeleton").waitFor({ state: "hidden", timeout: WAIT_MS });
}

/** A public room from the create form; `max` sets the seat count, `password` locks it. Returns its name. */
async function createRoomOf(h, base, roomName, { max, password } = {}) {
  const { page } = h;
  await page.goto(base);
  await menuName(page).waitFor();
  await playFromMenu(page, null);
  await button(page, "New room").click();
  await page.getByRole("heading", { name: "Create a room", exact: true }).waitFor();
  await page.getByLabel("room name", { exact: true }).fill(roomName);
  if (password) await page.getByLabel("Password", { exact: true }).fill(password);
  if (max) {
    const seats = page.getByLabel("Max players", { exact: true });
    await seats.fill(String(max));
    await seats.press("Tab");
  }
  await button(page, "Create room").click();
  await roomTitle(page, roomName).waitFor();
  return roomName;
}

async function browseClick(s, rtt) {
  const h = await open(s, "guest", { name: uniqueName("guest") });
  const { page } = h;
  setRtt(h, rtt);
  await page.goto(s.base);
  await menuName(page).waitFor();
  const t = await clickToScreen(page, () => navTo(page, "Browse rooms"), `Browse at ${rtt} ms`);
  if (rtt > 0) check(t.skel, `Browse at ${rtt} ms: no pending skeleton on the screen change`);
  await browseHeading(page).waitFor();
  await page.locator(".room-skeleton").waitFor({ state: "hidden", timeout: WAIT_MS });
  return `Browse at ${rtt} ms: screen-in ${t.ms.toFixed(0)} ms after the click; skeleton ${t.skel}`;
}

async function joinClick(s, rtt) {
  const host = await open(s, "host", { name: uniqueName("host") });
  const roomName = await createRoomOf(host, s.base, uniqueName("room"));
  const h = await open(s, "guest", { name: uniqueName("guest") });
  const { page } = h;
  await goBrowse(page, s.base);
  await roomRow(page, roomName).waitFor();
  setRtt(h, rtt);
  const t = await clickToScreen(page, () => roomRow(page, roomName).locator("button.room-row").click(), `join at ${rtt} ms`);
  if (rtt > 0) check(t.joining, `join at ${rtt} ms: no pending joining state on the screen change`);
  await roomTitle(page, roomName).waitFor({ timeout: WAIT_MS });
  return `join at ${rtt} ms: screen-in ${t.ms.toFixed(0)} ms after the click; joining ${t.joining}`;
}

/** The list cannot load: the error stays on Browse with Try again. Try again loads it; Back from the error goes to the menu. */
async function connectFail(s, { retry }) {
  const h = await open(s, "guest", { name: uniqueName("guest") });
  const { page } = h;
  await page.goto(s.base);
  await menuName(page).waitFor();
  h.link.hole = true;
  await navTo(page, "Browse rooms");
  await page.locator(".room-error").waitFor({ state: "visible", timeout: WAIT_MS });
  check(await retryButton(page).isVisible(), "the list error has no Try again");
  const text = ((await page.locator(".room-error-text").textContent()) ?? "").trim();
  check(text !== "", "the list error has no text");
  check(await browseHeading(page).isVisible(), "the list error is not on Browse");
  if (retry) {
    h.link.hole = false;
    await retryButton(page).click();
    await page.locator(".room-error").waitFor({ state: "hidden", timeout: WAIT_MS });
    await page.locator(".room-skeleton").waitFor({ state: "hidden", timeout: WAIT_MS });
    check(await browseHeading(page).isVisible(), "Try again did not load the list on Browse");
    await page.goBack();
    await menuName(page).waitFor({ timeout: WAIT_MS });
    return `list error "${text}"; Try again loaded the list; Back then reached the menu`;
  }
  await page.goBack();
  await menuName(page).waitFor({ timeout: WAIT_MS });
  return `list error "${text}"; Back from the error reached the menu`;
}

async function roomFull(s) {
  const host = await open(s, "host", { name: uniqueName("host") });
  const roomName = await createRoomOf(host, s.base, uniqueName("full"), { max: 1 });
  const h = await open(s, "guest", { name: uniqueName("guest") });
  const { page } = h;
  await goBrowse(page, s.base);
  await roomRow(page, roomName).locator("button.room-row").click();
  await page.getByText("The room is full. Pick another room from the list.").first().waitFor({ timeout: WAIT_MS });
  check(await browseHeading(page).isVisible(), "a full room did not return to Browse");
  return "room full: the join came back to Browse with the room-full message";
}

async function wrongPassword(s) {
  const host = await open(s, "host", { name: uniqueName("host") });
  const roomName = await createRoomOf(host, s.base, uniqueName("locked"), { password: PASSWORD });
  const h = await open(s, "guest", { name: uniqueName("guest") });
  const { page } = h;
  await goBrowse(page, s.base);
  const row = roomRow(page, roomName);
  await row.locator("button.room-row").click();
  const field = row.getByLabel(`password for ${roomName}`, { exact: true });
  await field.fill("not-the-password");
  await row.locator("form.room-password").getByRole("button", { name: "Join", exact: true }).click();
  await page.getByText(/wrong password/i).first().waitFor({ timeout: WAIT_MS });
  check(await browseHeading(page).isVisible(), "a wrong password did not return to Browse");
  check(await field.isVisible(), "the password field closed after the refusal");
  await field.fill(PASSWORD);
  await row.locator("form.room-password").getByRole("button", { name: "Join", exact: true }).click();
  await roomTitle(page, roomName).waitFor({ timeout: WAIT_MS });
  return "wrong password: back on Browse with the message and the field open; the right password joins";
}

async function cancelPending(s) {
  const host = await open(s, "host", { name: uniqueName("host") });
  const roomName = await createRoomOf(host, s.base, uniqueName("room"));
  const h = await open(s, "guest", { name: uniqueName("guest") });
  const { page } = h;
  await goBrowse(page, s.base);
  setRtt(h, 400);
  await roomRow(page, roomName).locator("button.room-row").click();
  await joining(page).waitFor({ state: "visible", timeout: WAIT_MS });
  await joining(page).getByRole("button", { name: "Cancel", exact: true }).click();
  await browseHeading(page).waitFor({ timeout: WAIT_MS });
  await joining(page).waitFor({ state: "hidden", timeout: WAIT_MS });
  await page.locator(".room-skeleton").waitFor({ state: "hidden", timeout: WAIT_MS });
  await sleep(1_500);
  check(await browseHeading(page).isVisible(), "Cancel left the pending join");
  check((await roomTitle(page, roomName).count()) === 0, "the room opened after Cancel");
  return "Cancel at 400 ms RTT: back on Browse, the list loads again, no room";
}

async function backPending(s) {
  const host = await open(s, "host", { name: uniqueName("host") });
  const roomName = await createRoomOf(host, s.base, uniqueName("room"));
  const h = await open(s, "guest", { name: uniqueName("guest") });
  const { page } = h;
  await goBrowse(page, s.base);
  setRtt(h, 400);
  await roomRow(page, roomName).locator("button.room-row").click();
  await joining(page).waitFor({ state: "visible", timeout: WAIT_MS });
  await page.goBack();
  await browseHeading(page).waitFor({ timeout: WAIT_MS });
  await joining(page).waitFor({ state: "hidden", timeout: WAIT_MS });
  await sleep(2_000);
  check(await browseHeading(page).isVisible(), "Back left the pending join");
  check((await roomTitle(page, roomName).count()) === 0, "the room opened after Back");
  return "Back at 400 ms RTT: Browse, not the room; still on Browse after 2 s";
}

export const transitionScenarios = [
  ...RTTS.map((rtt) => ({ name: `transition browse click ${rtt} ms`, run: (s) => browseClick(linked(s), rtt), serial: true })),
  ...RTTS.map((rtt) => ({ name: `transition join click ${rtt} ms`, run: (s) => joinClick(linked(s), rtt), serial: true })),
  { name: "transition connect fail try again", run: (s) => connectFail(linked(s), { retry: true }), serial: true },
  { name: "transition connect fail back", run: (s) => connectFail(linked(s), { retry: false }), serial: true },
  { name: "transition room full", run: (s) => roomFull(linked(s)), serial: true },
  { name: "transition wrong password", run: (s) => wrongPassword(linked(s)), serial: true },
  { name: "transition cancel pending", run: (s) => cancelPending(linked(s)), serial: true },
  { name: "transition back pending", run: (s) => backPending(linked(s)), serial: true },
];
