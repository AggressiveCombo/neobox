// Layout-shift QA instrument. Records the bounding boxes of the layout regions of a screen before and
// after an action and fails when a region that should not move does.
//
// Why the earlier instruments missed these shifts: motion.mjs compares pixels of transitions, temporal.mjs
// and escapes.mjs watch the state of single elements over time, and the dead-control scans look for
// unclickable controls. None of them compares where the regions sit before and after content grows or a
// scrollbar appears, so a column that grows with its chat log, or a page that shifts sideways when its
// scrollbar appears, passes every one of them.
//
// Cases (every selected engine):
//   chat.desktop        room lobby, 1280x800: 10 chat messages; the roster, match, chat panel, log and dock must not move or resize
//   chat.phone          room lobby, 390x844 on the Chat tab: the same, for the phone tab layout
//   scroll.<screen>.<mode>  Settings, Friends, Library, About, Privacy, Account at 1280 wide. The menu is measured with
//                       no scrollbar; then the screen is opened and the viewport is shortened until its page scrolls (a
//                       scrollbar appears). Every region must keep its x and width. Chromium runs with classic
//                       scrollbars (Playwright hides them by default, so their width never shows). mode `native` runs the
//                       engine as it is; mode `nogutter` serves the stylesheet with `scrollbar-gutter` renamed, which is
//                       what an engine without that rule (older Safari) does. The layout must still hold. A screen that
//                       does not scroll with the data at hand is info, not a pass.
//
// Keys: layout.moved (regions that moved or resized), layout.regions (regions compared), layout.scrolls
// (scroll cases: the page really scrolled after the resize), layout.moved.px (largest move in px).
//
// Usage:  cd client && QA_OUT=C:/Users/aggressivecombo/neobox-scratch/qa/layout bun qa/layout.mjs
//         (QA_ENGINES=chromium narrows the engines; QA_CASES=chat,scroll.settings narrows the cases by prefix)
// Self-test (QA_SELF_TEST=shift): a 40 px margin is added below the chat panel after the messages, so chat.desktop
// must FAIL on every engine. Use a separate QA_OUT for it.

import {
  Results,
  launchEngine,
  runCleanups,
  selectedEngines,
  selfTestMode,
  sleep,
  startServer,
  uniqueName,
  writeIndex,
} from "./lib-qa.mjs";
import { createRoom, gotoApp, menuName, navTo, Scenario, signedIn } from "../e2e/lib.mjs";

const mode = selfTestMode();
const TOL = 0.5; // px: below this a sub-pixel difference is not a move
// The server gives each chat sender a burst of 3 messages, then one every 3 s (room.rs CHAT_BURST, CHAT_REFILL_SECS);
// a message sent with no token left is dropped. After the burst the messages wait for a refill.
const CHAT_BURST = 3;
const CHAT_REFILL_MS = 3100;
const MESSAGES = 10; // enough to overflow the chat log on both lobbies
const MESSAGE_WAIT_MS = 8000;
const SETTLE_MS = 400;
const SCROLL_HEIGHT = 1200; // the main menu fits here with no scrollbar; every screen opened from it scrolls
const SHIFT_CSS = ".room-col-chat{margin-bottom:40px!important}"; // self-test: a region moves after the messages
const NO_GUTTER = (css) => css.replaceAll("scrollbar-gutter", "scrollbar-gutter-emu"); // an engine that ignores the rule

// Lobby regions: the roster, match and chat panels, the chat log, the dock and the mode tabs.
const ROOM_REGIONS = [".room-screen .room-tabs", ".room-screen h1", ".room-screen .panel", ".room-screen .room-col-chat", ".room-screen .room-chat-log", ".room-screen .room-dock"];
// Page chrome every screen shares (the menu, too), in the same place: a scrollbar that takes width moves it.
const SCREEN_REGIONS = ["#ui main.page", "#ui header"];

// open: the menu control of the screen (the drum for most; the privacy and account buttons sit outside it).
const SCREENS = [
  { id: "settings", open: (page) => navTo(page, "Settings") },
  { id: "friends", open: (page) => navTo(page, "Friends") },
  { id: "library", open: (page) => navTo(page, "Library") },
  { id: "about", open: (page) => navTo(page, "About") },
  { id: "privacy", open: (page) => page.locator("button.home-privacy").click() },
  { id: "account", open: (page) => page.locator("button.home-account").click() },
];

async function regionBoxes(page, selectors) {
  return page.evaluate((sels) => {
    const out = [];
    for (const sel of sels) {
      [...document.querySelectorAll(sel)].slice(0, 400).forEach((el, i) => {
        const r = el.getBoundingClientRect();
        out.push({ key: `${sel}#${i}`, x: r.x, y: r.y, w: r.width, h: r.height });
      });
    }
    return out;
  }, selectors);
}

// Compares two box lists by key. `axes` picks what must stay put: a chat growth moves y and h too.
function compare(before, after, axes) {
  const byKey = new Map(after.map((b) => [b.key, b]));
  const moved = [];
  let compared = 0;
  let maxPx = 0;
  for (const a of before) {
    const b = byKey.get(a.key);
    if (!b || a.w === 0 || b.w === 0) continue; // hidden on one side (a tab that is not selected)
    compared++;
    const deltas = Object.fromEntries(axes.map((axis) => [axis, Math.abs(a[axis] - b[axis])]));
    const worst = Math.max(...Object.values(deltas));
    maxPx = Math.max(maxPx, worst);
    if (worst > TOL) moved.push(`${a.key} ${axes.map((axis) => `${axis} ${a[axis].toFixed(1)}→${b[axis].toFixed(1)}`).join(" ")}`);
  }
  return { compared, moved, maxPx };
}

function report(before, after, axes, metrics, pass = true) {
  const r = compare(before, after, axes);
  metrics["layout.regions"] = r.compared;
  metrics["layout.moved"] = r.moved.length;
  metrics["layout.moved.px"] = Number(r.maxPx.toFixed(2));
  return { pass: pass && r.moved.length === 0 && r.compared > 0, detail: r.moved.slice(0, 6).join("; ") || (r.compared === 0 ? "no regions compared" : undefined), metrics };
}

async function chatCase(s, base, { phone }) {
  const h = await s.open(phone ? "room-phone" : "room", { name: uniqueName("layout"), phone });
  const { page } = h;
  await createRoom(h, base, uniqueName("layout"));
  if (phone) await page.locator("button[role=tab][data-tab=chat]").click();
  await sleep(SETTLE_MS);
  const before = await regionBoxes(page, ROOM_REGIONS);
  const chat = page.getByLabel("Chat message", { exact: true });
  const start = await page.locator("div.room-chat-log .room-chat-line").count();
  let sent = 0;
  try {
    for (; sent < MESSAGES; sent++) {
      if (sent >= CHAT_BURST) await sleep(CHAT_REFILL_MS);
      await chat.fill(`layout check message ${sent} with enough words to wrap onto a second line in the log`);
      await chat.press("Enter");
      await page.waitForFunction((n) => document.querySelectorAll("div.room-chat-log .room-chat-line").length >= n, start + sent + 1, { timeout: MESSAGE_WAIT_MS });
    }
  } catch (err) {
    const shown = await page.locator("div.room-chat-log .room-chat-line").count();
    return { pass: false, detail: `only ${sent} of ${MESSAGES} messages reached the log (${shown - start} lines): ${err.message.split("\n")[0]}` };
  }
  if (mode === "shift") await page.addStyleTag({ content: SHIFT_CSS });
  await sleep(SETTLE_MS);
  const after = await regionBoxes(page, ROOM_REGIONS);
  const metrics = { "layout.messages": MESSAGES };
  return report(before, after, ["x", "y", "w", "h"], metrics);
}

async function scrollCase(s, base, screen, { nogutter }) {
  const h = await signedIn(s, `scroll-${screen.id}`, uniqueName("layout"));
  const { page } = h;
  if (nogutter) {
    await page.route(/\.css(\?.*)?$/, async (route) => {
      const res = await route.fetch();
      await route.fulfill({ response: res, body: NO_GUTTER(await res.text()) });
    });
    await gotoApp(page, base); // the stylesheet is served through the route from here on
    await menuName(page).waitFor();
  }
  await page.setViewportSize({ width: 1280, height: SCROLL_HEIGHT });
  await sleep(SETTLE_MS);
  const scrollsNow = () =>
    page.evaluate(() => {
      const ui = document.querySelector("#ui");
      return ui.scrollHeight > ui.clientHeight;
    });
  // before: the menu with no scrollbar; after: the screen opened from it, at the first height where it scrolls
  if (await scrollsNow()) return { info: true, detail: `the menu scrolls at ${SCROLL_HEIGHT}px: no scrollbar-free baseline` };
  const before = await regionBoxes(page, SCREEN_REGIONS);
  await screen.open(page);
  let scrolls = false;
  for (const height of [SCROLL_HEIGHT, 900, 700, 540]) {
    await page.setViewportSize({ width: 1280, height });
    await sleep(SETTLE_MS);
    scrolls = await scrollsNow();
    if (scrolls) break;
  }
  const after = await regionBoxes(page, SCREEN_REGIONS);
  const metrics = { "layout.scrolls": scrolls };
  if (!scrolls) return { info: true, detail: `does not scroll at any height tried (${SCROLL_HEIGHT} to 540px) with this data`, metrics };
  return report(before, after, ["x", "w"], metrics);
}

const CASES = [
  { id: "chat.desktop", run: (s, base) => chatCase(s, base, { phone: false }) },
  { id: "chat.phone", run: (s, base) => chatCase(s, base, { phone: true }) },
  ...SCREENS.flatMap((screen) =>
    ["native", "nogutter"].map((m) => ({ id: `scroll.${screen.id}.${m}`, run: (s, base) => scrollCase(s, base, screen, { nogutter: m === "nogutter" }) })),
  ),
];

const only = process.env.QA_CASES ? process.env.QA_CASES.split(",") : null;

for (const engine of selectedEngines()) {
  const browser = await launchEngine(engine, { scrollbars: true }); // classic scrollbars: the case is about their width
  const results = new Results("layout", engine);
  for (const c of CASES) {
    if (only && !only.some((p) => c.id.startsWith(p))) continue;
    const srv = await startServer();
    await results.case(c.id, (s) => c.run(s, srv.base), { browser, base: srv.base, info: false });
  }
  results.save();
}

writeIndex();
await runCleanups();
