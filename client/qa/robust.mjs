// Robustness instrument: console and network health, slow network, disconnect and reconnect,
// kick, app close, reload, back navigation, resize, phone rotation, tab switch, and a bad room code. Every case
// fails on uncaught page errors, unexpected console errors, and unexpected failed or >= 400
// requests. Deliberate faults (offline windows, the bad room) are marked expected and recorded
// as netExpected, not failed.
//
// Run: cd client && bun qa/robust.mjs         (QA_ENGINES=chromium to limit engines)
// Output: <QA_OUT>/robust-<engine>.{json,md}, evidence under <QA_OUT>/evidence/robust-<engine>/.
// Self-test: QA_SELF_TEST=console (console error at load), request (failed request at load), or badroom
// (a real room code where the unknown one is expected) runs only that check with the fault; it must FAIL.

import {
  Results,
  button,
  cdpOf,
  createRoom,
  dismissPhoneSplash,
  launchEngine,
  matchWithGuest,
  muteAudio,
  median,
  menuName,
  navTo,
  roomTitle,
  runCleanups,
  selectedEngines,
  selfTestMode,
  setNetwork,
  sleep,
  startPractice,
  startServer,
  uniqueName,
  watchPage,
  writeIndex,
} from "./lib-qa.mjs";
import { joinByInvite, setContextOffline, signedIn } from "../e2e/lib.mjs";

// Deliberate faults the instrument creates on purpose. Their failed requests are expected.
let offline = false;
let allowUrl = null;
let trackSockets = false;
let blockSockets = false;
let gateSockets = false;
const MODE = selfTestMode();
// Failed websocket and offline requests are expected while the instrument cuts the network.
const CONSOLE_OFFLINE = /WebSocket|websocket|establish a connection|ERR_INTERNET_DISCONNECTED|ERR_NAME|NetworkError|Failed to fetch|NS_ERROR|Failed to load resource/i;
/** WebKit reports a fetch the network refused as an error of its own, even when the caller catches the rejection. */
const OFFLINE_FETCH_NOISE = /Fetch API cannot load \S+ due to access control checks/;
/** Runs only the cases whose id contains this text (ROBUST_ONLY=offline.warm); every case when unset. */
const ONLY = process.env.ROBUST_ONLY ?? "";
const RECONNECT_CYCLES = 3;
const BANNER_BUDGET_MS = 10000;
const RECOVER_BUDGET_MS = 30000;
const OFFLINE_HOLD_MS = 20000;
const BLIP_HOLD_MS = 4000;
const GIVE_UP_BUDGET_MS = 100000;
const GIVE_UP_TEXT = "could not reconnect to the room";
const HIDDEN_HOLD_MS = 60000;
const SLOW_TIMEOUT_MS = 90000;
// Whole-case budget (see withBudget); a hung case fails as 'timeout' instead of hanging the run.
const CASE_TIMEOUT_MS = 240000;
// Refresh cases re-create state under parallel load; their waits use this instead of the 15s default.
const LOAD_TIMEOUT_MS = 45000;

// Records every WebSocket the page creates, so the instrument can drop the live socket.
const TRACK_SOCKETS = () => {
  const Orig = window.WebSocket;
  window.__ws = [];
  window.WebSocket = new Proxy(Orig, {
    construct(target, args) {
      const socket = Reflect.construct(target, args);
      window.__ws.push(socket);
      return socket;
    },
  });
};

// Routes a page's sockets through the instrument. While blockSockets is set a socket is refused at once, so a
// reconnect cannot succeed; otherwise it is passed through to the server unchanged.
const gateSocket = async (ws) => {
  if (blockSockets) {
    await ws.close({ code: 4001, reason: "qa offline" });
    return;
  }
  const server = ws.connectToServer();
  ws.onMessage((msg) => server.send(msg));
  server.onMessage((msg) => ws.send(msg));
};

/** Hides navigator.gpu for the WebGL2 path, records sockets when asked, and watches every page. */
function prepare(s, renderer = "webgpu") {
  const openOriginal = s.open.bind(s);
  s.open = async (label, opts) => {
    const h = await openOriginal(label, opts);
    await muteAudio(h.context);
    if (renderer === "webgl2") {
      await h.context.addInitScript(() => {
        Object.defineProperty(navigator, "gpu", { value: undefined, configurable: true });
      });
    }
    // Self-test faults (QA_SELF_TEST): boot.clean.webgl2 must FAIL on either.
    if (MODE === "console") await h.context.addInitScript(() => console.error("qa self-test: injected console error"));
    if (MODE === "request") await h.context.addInitScript(() => fetch("http://127.0.0.1:1/qa-selftest").catch(() => undefined));
    if (trackSockets) await h.context.addInitScript(TRACK_SOCKETS);
    if (gateSockets) await h.page.routeWebSocket(/.*/, gateSocket);
    watchPage(h, { expected: (url) => offline || (allowUrl !== null && allowUrl.test(url)) });
    return h;
  };
}

const warningsOf = (s) => s.handles.flatMap((h) => h.warnings ?? []);

/**
 * Whole-case budget: a case that stops making progress fails as 'timeout' (Results.case still
 * screenshots its open pages) instead of hanging the whole run.
 */
function withBudget(work) {
  let timer;
  const limit = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`timeout: no result after ${CASE_TIMEOUT_MS / 1000}s`)), CASE_TIMEOUT_MS);
  });
  const named = Promise.resolve(work).catch((err) => {
    if (err instanceof Error && err.message) throw err;
    throw new Error(`${err?.name || "Error"} with no message: ${String(err?.stack ?? err).split("\n").slice(0, 2).join(" ")}`);
  });
  return Promise.race([named, limit]).finally(() => clearTimeout(timer));
}

/**
 * Runs one case under withBudget, closes its browsers afterwards, and gives a failure with no detail
 * one built from its problems and failed requests, so the console line says what broke.
 */
async function runCase(results, id, fn, opts) {
  if (!id.includes(ONLY)) return null;
  let scenario = null;
  const rec = await results.case(
    id,
    (s) => {
      scenario = s;
      return withBudget(fn(s));
    },
    opts,
  );
  if (rec.verdict === "fail" && !rec.detail) {
    const parts = [...(rec.problems ?? []), ...(rec.netFailed ?? [])];
    rec.detail = parts.length ? `${parts.length} unexpected: ${parts.slice(0, 3).join(" | ")}` : "failed with no error and no recorded problem";
    console.log(`  ${id}: ${rec.detail}`);
  }
  if (scenario) await Promise.all(scenario.handles.map((h) => h.context.close().catch(() => undefined)));
  return rec;
}

/** The portrait-gate dialog of the phone rotation check. */
const gateOf = (page) => page.getByRole("dialog", { name: "Turn your phone sideways", exact: true });

/** Starts a practice game from the menu on a phone-emulated page. */
async function startPhonePractice(page, base) {
  await page.goto(base);
  await dismissPhoneSplash(page);
  await menuName(page).waitFor();
  await navTo(page, "Practice");
  await page.locator(".offline-list .offline-choice").first().click();
  await button(page, "Start").click();
  await page.locator(".offline.playing").waitFor();
}

/** Opens a phone-emulated page at an exact viewport; Scenario.open only offers the portrait phone size. */
async function openPhoneAt(s, label, viewport) {
  const browser = s.env.browser;
  s.env = {
    ...s.env,
    browser: {
      browserType: () => browser.browserType(),
      newContext: async (opts) => {
        const context = await browser.newContext({ ...opts, viewport });
        await holdViewport(context);
        return context;
      },
    },
  };
  try {
    return await s.open(label, { phone: true, name: uniqueName("ph") });
  } finally {
    s.env = { ...s.env, browser };
  }
}

/**
 * Firefox headless turns a started game into real fullscreen (1366x768), which overrides the emulated
 * viewport and makes the orientation under test meaningless. Fullscreen requests are made no-ops here,
 * so the page keeps the emulated size and goLandscape takes its no-lock path (the browser refused it).
 */
async function holdViewport(context) {
  await context.addInitScript(() => {
    Element.prototype.requestFullscreen = () => Promise.resolve();
  });
}

async function bootCase(s, base, renderer) {
  prepare(s, renderer);
  // The product registers its service worker; the Scenario default ("block") makes Playwright log its own warning.
  const h = await s.open("boot", { serviceWorkers: "allow" });
  await startPractice(h, base, renderer);
  // The webgl2 case hides navigator.gpu on purpose, so the app's WebGPU-unavailable notice is expected there.
  const all = warningsOf(s);
  const warnings = all.filter((w) => !(renderer === "webgl2" && /WebGPU unavailable/.test(w)));
  return {
    pass: warnings.length === 0,
    metrics: { "console.warnings": warnings.length, "console.expectedWarnings": all.length - warnings.length },
    detail: warnings.length ? `${warnings.length} console warnings` : undefined,
  };
}

async function refreshPracticeCase(s, base, renderer) {
  prepare(s, renderer);
  const h = await s.open("refresh");
  h.page.setDefaultTimeout(LOAD_TIMEOUT_MS);
  await startPractice(h, base, renderer);
  await h.page.reload();
  await menuName(h.page).waitFor({ timeout: LOAD_TIMEOUT_MS });
  return { pass: true };
}

async function refreshRoomCase(s, base) {
  prepare(s);
  const host = await s.open("host", { name: uniqueName("host") });
  host.page.setDefaultTimeout(LOAD_TIMEOUT_MS);
  const roomName = uniqueName("room");
  const t0 = Date.now();
  await createRoom(host, base, roomName, { isPublic: false });
  const createMs = Date.now() - t0;
  await host.page.reload();
  await roomTitle(host.page, roomName).waitFor({ timeout: LOAD_TIMEOUT_MS });
  return { pass: true, metrics: { "refresh.room.createMs": createMs } };
}

async function backForwardCase(s, base, renderer) {
  prepare(s, renderer);
  const h = await s.open("nav");
  await h.page.goto(base);
  await menuName(h.page).waitFor();
  const before = h.page.url();
  await navTo(h.page, "Practice");
  await h.page.locator(".offline-list").waitFor();
  const pushed = h.page.url() !== before;
  await h.page.goBack();
  const backOk = await menuName(h.page)
    .waitFor({ timeout: 5000 })
    .then(() => true, () => false);
  return {
    pass: backOk,
    metrics: { "nav.urlChangesOnNavigate": pushed, "nav.backReturnsToMenu": backOk },
    detail: backOk ? undefined : `back landed on ${h.page.url()}`,
  };
}

async function slowNetCase(s, base, renderer) {
  prepare(s, renderer);
  const h = await s.open("slow3g");
  await setNetwork(await cdpOf(h.page), "slow3g");
  const t0 = Date.now();
  await startPractice(h, base, renderer, { timeout: SLOW_TIMEOUT_MS });
  return { pass: true, metrics: { "net.slow3g.readyMs": Date.now() - t0 } };
}

/** Drops the live websocket of every page in the match, as a server-side close would. Returns how many were open. */
async function dropSockets(page) {
  return page.evaluate(() => {
    let cut = 0;
    for (const socket of window.__ws ?? []) {
      if (socket.readyState !== WebSocket.OPEN) continue;
      socket.close(4000, "qa drop");
      cut++;
    }
    return cut;
  });
}

async function reconnectCase(s) {
  prepare(s);
  trackSockets = true;
  let match;
  try {
    match = await matchWithGuest(s, { clipboard: false });
  } finally {
    trackSockets = false;
  }
  const { host } = match;
  const rows = [];
  for (let i = 0; i < RECONNECT_CYCLES; i++) {
    const banner = host.page.locator(".reconnect-banner");
    await dropSockets(host.page);
    const shown = await banner
      .waitFor({ state: "visible", timeout: BANNER_BUDGET_MS })
      .then(() => true, () => false);
    const t0 = Date.now();
    const gone = await banner
      .waitFor({ state: "hidden", timeout: RECOVER_BUDGET_MS })
      .then(() => true, () => false);
    const ms = Date.now() - t0;
    const hud = await host.page.locator(".hud-leave").isVisible();
    rows.push({ shown, gone, hud, ms });
    await sleep(500);
  }
  const pass = rows.every((r) => r.shown && r.gone && r.hud);
  return {
    pass,
    metrics: {
      "reconnect.cycles": rows.length,
      "reconnect.bannerShown": rows.filter((r) => r.shown).length,
      "reconnect.hudBack": rows.filter((r) => r.hud).length,
      "reconnect.ms.median": median(rows.map((r) => r.ms)),
      "reconnect.ms.runs": rows.map((r) => r.ms),
    },
    detail: pass ? undefined : `cycles: ${JSON.stringify(rows)}`,
  };
}

/**
 * Cuts or restores the network for the whole window. Chromium uses CDP offline emulation: unlike setOffline it also
 * refuses new WebSockets, so the reconnect cannot succeed. Other engines use setOffline; their new sockets are
 * refused by the route (blockSockets).
 */
async function setNetworkOff(host, session, off) {
  if (session) {
    await session.send("Network.emulateNetworkConditions", { offline: off, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
  } else {
    await setContextOffline(host.context, off);
  }
}

/**
 * The network itself goes away for a while, as on a dropped Wi-Fi. The window is held offline and the page's
 * sockets are refused (blockSockets) so the reconnect cannot succeed; the banner has to stay up for the whole window.
 */
async function networkOffCase(s, cdp) {
  prepare(s);
  trackSockets = true;
  gateSockets = true;
  let match;
  try {
    match = await matchWithGuest(s, { clipboard: false });
  } finally {
    trackSockets = false;
    gateSockets = false;
  }
  const { host } = match;
  const banner = host.page.locator(".reconnect-banner");
  // CDP network emulation is per session: the same session cuts and restores the network.
  const session = cdp ? await host.context.newCDPSession(host.page) : null;
  // The gate refuses new sockets before the drop, so the reconnect cannot succeed while the page is still online.
  offline = true;
  blockSockets = true;
  const t0 = Date.now();
  // A real Wi-Fi loss kills the live socket. Close it while online: taking the network down first leaves the close
  // handshake waiting for a server reply that never comes, so no close event fires (states.mjs dropAndGoOffline).
  const cut = await dropSockets(host.page);
  const shownAt = await banner
    .waitFor({ state: "visible", timeout: BANNER_BUDGET_MS })
    .then(() => Date.now() - t0, () => null);
  await setNetworkOff(host, session, true);
  const holdFrom = Date.now();
  // Timeline of the window (every 500 ms) so a miss is visible as a sequence, not one reading.
  const timeline = [];
  const sampling = (async () => {
    while (Date.now() - holdFrom < OFFLINE_HOLD_MS) {
      timeline.push({
        t: Date.now() - holdFrom,
        shown: await banner.isVisible().catch(() => "err"),
      });
      await sleep(500);
    }
  })();
  await sleep(Math.max(0, OFFLINE_HOLD_MS - (Date.now() - holdFrom)));
  const heldToEnd = await banner.isVisible().catch(() => false);
  await sampling;
  await setNetworkOff(host, session, false);
  blockSockets = false;
  offline = false;
  const back = Date.now();
  const gone = await banner
    .waitFor({ state: "hidden", timeout: RECOVER_BUDGET_MS })
    .then(() => true, () => false);
  const recoverMs = Date.now() - back;
  const hud = await host.page.locator(".hud-leave").isVisible();
  const failed = [
    cut > 0 ? null : "no open socket to cut (not exercised)",
    shownAt !== null && shownAt <= BANNER_BUDGET_MS ? null : `banner shown after ${shownAt ?? "never"} ms (budget ${BANNER_BUDGET_MS})`,
    heldToEnd ? null : "banner hidden during the offline hold",
    gone ? null : "banner still visible after the network returned",
    hud ? null : "HUD leave control not visible after recovery",
  ].filter((f) => f !== null);
  const pass = failed.length === 0;
  return {
    pass,
    metrics: {
      "offline.bannerAfterMs": shownAt,
      "offline.socketsCut": cut,
      "offline.heldToEnd": heldToEnd,
      "offline.recoverMs": gone ? recoverMs : null,
      "offline.hudBack": hud,
    },
    detail: pass ? undefined : `failed: ${failed.join("; ")}; timeline ${JSON.stringify(timeline)}`,
  };
}

/** The Try again inside one screen's offline section; the menu's own Try again buttons are outside it. */
function sectionRetry(page, title) {
  return page.locator("section.offline-state").filter({ has: page.getByRole("heading", { name: `${title} unavailable offline` }) }).getByRole("button", { name: "Try again", exact: true });
}

/**
 * The page loads online, then the network goes away and every server-backed screen is opened from the cache.
 * Each one has to say it is unavailable offline with a Try again. Try again while offline says it is still offline, and
 * once the network is back the browser's online event reopens the screen.
 */
async function offlineWarmCase(s, base, cdp, engine) {
  prepare(s);
  // The offline case needs the worker to serve the shell: with it blocked, navigator.serviceWorker.ready never resolves.
  const host = await s.open("offline", { name: uniqueName("off"), serviceWorkers: "allow" });
  host.page.setDefaultTimeout(LOAD_TIMEOUT_MS);
  await host.page.goto(base);
  await menuName(host.page).waitFor();
  await host.page.evaluate(() => navigator.serviceWorker?.ready.then(() => 1));
  // A returning visit: the service worker controls the page before the network goes away.
  await host.page.reload();
  await menuName(host.page).waitFor();
  await host.page.waitForFunction(() => navigator.serviceWorker?.controller !== null);
  const session = cdp ? await host.context.newCDPSession(host.page) : null;
  offline = true;
  await setNetworkOff(host, session, true);
  // A navigation, not a reload: Firefox refuses a reload of the controlled page while offline; goto is served by the worker.
  await host.page.goto(base);
  await menuName(host.page).waitFor();
  // Firefox's setOffline does not stop page fetches to loopback, so the stats request is refused by route once the page is up.
  await host.context.route("**/api/stats", (route) => route.abort("internetdisconnected"));
  const failed = [];
  for (const title of ["Browse rooms", "Quick play", "Library", "Friends"]) {
    await navTo(host.page, title);
    const shown = await host.page.getByRole("heading", { name: `${title} unavailable offline` }).waitFor({ timeout: 5000 }).then(() => true, () => false);
    const retry = await sectionRetry(host.page, title).isVisible();
    if (!shown || !retry) failed.push(title);
    await host.page.goBack();
    await menuName(host.page).waitFor();
  }
  await navTo(host.page, "Browse rooms");
  await sectionRetry(host.page, "Browse rooms").click();
  const stillNoted = await host.page.getByText("Still offline. Try again when the connection is back.").waitFor({ timeout: 5000 }).then(() => true, () => false);
  await host.context.unroute("**/api/stats");
  // The network comes back. Playwright's Firefox never sends `online` to a document that was loaded while offline
  // (navigator.onLine turns true but the event is not dispatched), so the page is given the event after a real restore.
  await host.page.evaluate(() => { window.__onlineSeen = false; window.addEventListener("online", () => { window.__onlineSeen = true; }, { once: true }); });
  await setNetworkOff(host, session, false);
  offline = false;
  const eventShimmed = await host.page.waitForFunction(() => window.__onlineSeen === true, null, { timeout: 2000 }).then(() => false, () => true);
  if (eventShimmed && engine === "firefox") await host.page.evaluate(() => window.dispatchEvent(new Event("online")));
  const recovered = await host.page.getByRole("heading", { name: "Browse rooms unavailable offline" }).waitFor({ state: "detached", timeout: RECOVER_BUDGET_MS }).then(() => true, () => false);
  const pass = failed.length === 0 && stillNoted && recovered && (!eventShimmed || engine === "firefox");
  return {
    pass,
    metrics: { "offline.sectionsChecked": 4, "offline.sectionsFailed": failed.length, "offline.retryStillOffline": stillNoted, "offline.onlineReopens": recovered, "offline.onlineEventShimmed": eventShimmed },
    detail: pass ? undefined : `failed: ${failed.join(", ") || "none"}; still-offline note ${stillNoted}; reopened online ${recovered}; online event shimmed ${eventShimmed}`,
  };
}

const playerRow = (page, name) => page.locator("li.room-player").filter({ hasText: name });

/** A room with a host and a guest in its lobby (no match), the guest joined by the host's invite. */
async function lobbyPair(s) {
  const hostName = uniqueName("host");
  const guestName = uniqueName("guest");
  const roomName = uniqueName("room");
  const host = await s.open("host", { name: hostName });
  const code = await createRoom(host, s.base, roomName, { isPublic: true });
  const guest = await s.open("guest", { name: guestName });
  await joinByInvite(guest, s.base, code, roomName);
  await playerRow(host.page, guestName).waitFor();
  await playerRow(guest.page, hostName).waitFor();
  return { host, guest, code, roomName, hostName, guestName };
}

/**
 * A brief loss of the link while in a room (BLIP_HOLD_MS): the host shows the reconnect banner and the guest marks the
 * host's seat as reconnecting. When the link is back both clear, and the host is still in the room.
 */
async function blipCase(s, cdp) {
  prepare(s);
  trackSockets = true;
  gateSockets = true;
  let pair;
  try {
    pair = await lobbyPair(s);
  } finally {
    trackSockets = false;
    gateSockets = false;
  }
  const { host, guest, roomName, hostName } = pair;
  const banner = host.page.locator(".reconnect-banner");
  const seat = playerRow(guest.page, hostName).locator(".room-offline");
  const session = cdp ? await host.context.newCDPSession(host.page) : null;
  offline = true;
  blockSockets = true;
  const cut = await dropSockets(host.page);
  await setNetworkOff(host, session, true);
  const shown = await banner.waitFor({ state: "visible", timeout: BANNER_BUDGET_MS }).then(() => true, () => false);
  const away = await seat.waitFor({ state: "visible", timeout: BANNER_BUDGET_MS }).then(() => true, () => false);
  await sleep(BLIP_HOLD_MS);
  await setNetworkOff(host, session, false);
  blockSockets = false;
  offline = false;
  const back = await banner.waitFor({ state: "hidden", timeout: RECOVER_BUDGET_MS }).then(() => true, () => false);
  const seatBack = await seat.waitFor({ state: "detached", timeout: RECOVER_BUDGET_MS }).then(() => true, () => false);
  const inRoom = await roomTitle(host.page, roomName).isVisible();
  const pass = cut > 0 && shown && away && back && seatBack && inRoom;
  return {
    pass,
    metrics: { "blip.bannerShown": shown, "blip.seatMarked": away, "blip.resumed": back && seatBack && inRoom },
    detail: pass ? undefined : `sockets cut ${cut}, banner shown ${shown}, seat marked ${away}, banner gone ${back}, seat back ${seatBack}, in room ${inRoom}`,
  };
}

/**
 * The server stays unreachable past the reconnect deadline while the network is up: every attempt fails, so the host
 * is taken back to the menu and told the room could not be reached. Offline, the app waits for the network instead
 * (networkOffCase).
 */
async function giveUpCase(s) {
  prepare(s);
  trackSockets = true;
  gateSockets = true;
  let pair;
  try {
    pair = await lobbyPair(s);
  } finally {
    trackSockets = false;
    gateSockets = false;
  }
  const { host } = pair;
  const banner = host.page.locator(".reconnect-banner");
  offline = true;
  blockSockets = true;
  let cut = 0;
  let shown = false;
  let gaveUp = false;
  let menu = false;
  try {
    cut = await dropSockets(host.page);
    shown = await banner.waitFor({ state: "visible", timeout: BANNER_BUDGET_MS }).then(() => true, () => false);
    gaveUp = await host.page
      .getByText(GIVE_UP_TEXT, { exact: true })
      .waitFor({ state: "visible", timeout: GIVE_UP_BUDGET_MS })
      .then(() => true, () => false);
    menu = await menuName(host.page).isVisible();
  } finally {
    blockSockets = false;
    offline = false;
  }
  const pass = cut > 0 && shown && gaveUp && menu;
  return {
    pass,
    metrics: { "giveUp.bannerShown": shown, "giveUp.toldPlayer": gaveUp, "giveUp.backInMenu": menu },
    detail: pass ? undefined : `sockets cut ${cut}, banner shown ${shown}, told ${gaveUp}, in menu ${menu}`,
  };
}

/**
 * The room's server goes away for good: the reconnect attempts are refused until the deadline, then the host is taken
 * back to the menu with the same notice. The case stops the server it is given.
 */
async function serverStopCase(s, server) {
  prepare(s);
  const { host } = await lobbyPair(s);
  const banner = host.page.locator(".reconnect-banner");
  offline = true;
  let shown = false;
  let gaveUp = false;
  let menu = false;
  try {
    await server.stop();
    shown = await banner.waitFor({ state: "visible", timeout: BANNER_BUDGET_MS }).then(() => true, () => false);
    gaveUp = await host.page
      .getByText(GIVE_UP_TEXT, { exact: true })
      .waitFor({ state: "visible", timeout: GIVE_UP_BUDGET_MS })
      .then(() => true, () => false);
    menu = await menuName(host.page).isVisible();
  } finally {
    offline = false;
  }
  const pass = shown && gaveUp && menu;
  return {
    pass,
    metrics: { "serverStop.bannerShown": shown, "serverStop.toldPlayer": gaveUp, "serverStop.backInMenu": menu },
    detail: pass ? undefined : `banner shown ${shown}, told ${gaveUp}, in menu ${menu}`,
  };
}

/** The host kicks the guest from the lobby: the guest is told so, and gets no reconnect banner. */
async function kickedCase(s) {
  prepare(s);
  const { host, guest, guestName } = await lobbyPair(s);
  await playerRow(host.page, guestName).getByRole("button", { name: `Actions for ${guestName}`, exact: true }).click();
  await host.page.getByRole("menuitem", { name: "Kick", exact: true }).click();
  const notice = guest.page.locator(".browser-notice").filter({ hasText: "kicked from the room" });
  const shown = await notice.waitFor({ state: "visible", timeout: LOAD_TIMEOUT_MS }).then(() => true, () => false);
  await sleep(2000);
  const banner = await guest.page.locator(".reconnect-banner").isVisible();
  const pass = shown && !banner;
  return {
    pass,
    metrics: { "kicked.noticeShown": shown, "kicked.reconnectBanner": banner },
    detail: pass ? undefined : `notice shown ${shown}, reconnect banner shown ${banner}`,
  };
}

/**
 * The host's page goes away with its socket open (navigated to about:blank): the page closes the socket quietly, so
 * no error is logged, the server holds the seat (the guest sees it reconnecting), and opening the room again takes it back.
 */
async function appClosedCase(s) {
  prepare(s);
  const { host, guest, code, roomName, hostName } = await lobbyPair(s);
  const seat = playerRow(guest.page, hostName);
  await host.page.goto("about:blank");
  const held = await seat
    .locator(".room-offline")
    .waitFor({ state: "visible", timeout: LOAD_TIMEOUT_MS })
    .then(() => true, () => false);
  await host.page.goto(`${s.base}/${code}`);
  await roomTitle(host.page, roomName).waitFor({ timeout: LOAD_TIMEOUT_MS });
  const back = await seat
    .locator(".room-offline")
    .waitFor({ state: "detached", timeout: LOAD_TIMEOUT_MS })
    .then(() => true, () => false);
  const entries = await seat.count();
  const pass = held && back && entries === 1;
  return {
    pass,
    metrics: { "appClosed.seatHeld": held, "appClosed.resumed": back },
    detail: pass ? undefined : `seat held ${held}, resumed ${back}, guest lists the host ${entries} times`,
  };
}

async function resizeMatchCase(s) {
  prepare(s);
  const { host } = await matchWithGuest(s, { clipboard: false });
  const sizes = [
    { width: 800, height: 600 },
    { width: 1280, height: 800 },
    { width: 420, height: 700 },
  ];
  const hud = [];
  for (const size of sizes) {
    await host.page.setViewportSize(size);
    await sleep(500);
    hud.push(await host.page.locator(".hud-leave").isVisible());
  }
  return {
    pass: hud.every(Boolean),
    metrics: { "resize.hudVisible": hud.filter(Boolean).length, "resize.steps": hud.length },
  };
}

async function rotatePhoneCase(s, base, engine) {
  prepare(s, "webgpu");
  if (engine === "firefox") return rotatePhoneSplit(s, base);
  const h = await s.open("phone", { phone: true, name: uniqueName("ph") });
  await startPhonePractice(h.page, base);
  const gate = gateOf(h.page);
  await sleep(500);
  const gatePortrait = await gate.isVisible();
  await h.page.setViewportSize({ width: 844, height: 390 });
  await sleep(800);
  const gateLandscape = await gate.isVisible();
  const playingLandscape = await h.page.locator(".offline.playing").isVisible();
  await h.page.setViewportSize({ width: 390, height: 844 });
  await sleep(800);
  const playingPortrait = await h.page.locator(".offline.playing").isVisible();
  return {
    pass: playingLandscape && playingPortrait && !gateLandscape,
    metrics: {
      "rotate.gatePortrait": gatePortrait,
      "rotate.gateLandscape": gateLandscape,
      "rotate.stillPlaying": playingLandscape && playingPortrait,
    },
  };
}

/**
 * Firefox headless closes the browser when setViewportSize changes a phone-emulated page, so live
 * rotation cannot run there. Each orientation is measured in its own fresh phone context instead:
 * portrait for the gate, landscape for the game. The return to portrait while playing is therefore
 * not observed on firefox (rotate.backMeasured false). Chromium and webkit keep the live rotation.
 */
async function rotatePhoneSplit(s, base) {
  const portrait = await openPhoneAt(s, "portrait", { width: 390, height: 844 });
  await startPhonePractice(portrait.page, base);
  await sleep(500);
  const gatePortrait = await gateOf(portrait.page).isVisible();
  const landscape = await openPhoneAt(s, "landscape", { width: 844, height: 390 });
  await startPhonePractice(landscape.page, base);
  await sleep(500);
  const gateLandscape = await gateOf(landscape.page).isVisible();
  const playingLandscape = await landscape.page.locator(".offline.playing").isVisible();
  const pass = gatePortrait && playingLandscape && !gateLandscape;
  return {
    pass,
    metrics: {
      "rotate.gatePortrait": gatePortrait,
      "rotate.gateLandscape": gateLandscape,
      "rotate.stillPlaying": null,
      "rotate.backMeasured": false,
    },
    detail: pass ? undefined : `portrait gate ${gatePortrait}, landscape gate ${gateLandscape}, landscape playing ${playingLandscape}`,
  };
}

/**
 * Hides or shows the page as a tab switch does: the browser's own visibility when headless reports it,
 * otherwise an override of document.visibilityState/hidden plus the visibilitychange event the page listens for.
 */
function setPageHidden(page, hidden) {
  return page.evaluate((hide) => {
    if (hide) {
      Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "hidden" });
      Object.defineProperty(document, "hidden", { configurable: true, get: () => true });
    } else {
      delete document.visibilityState;
      delete document.hidden;
    }
    document.dispatchEvent(new Event("visibilitychange"));
  }, hidden);
}

/** The match tab is hidden for HIDDEN_HOLD_MS while another tab is in front, then returned to. */
async function tabSwitchCase(s) {
  prepare(s);
  const { host } = await matchWithGuest(s, { clipboard: false });
  const page = host.page;
  const other = await host.context.newPage();
  await other.bringToFront();
  await sleep(1000);
  const native = (await page.evaluate(() => document.visibilityState)) === "hidden";
  if (!native) await setPageHidden(page, true);
  const hidden = (await page.evaluate(() => document.visibilityState)) === "hidden";
  if (!hidden) {
    await other.close();
    return { info: true, detail: "not exercised: the page could not be hidden" };
  }
  await sleep(HIDDEN_HOLD_MS);
  const visibilityWhileBackground = await page.evaluate(() => document.visibilityState);
  await other.close();
  if (native) await page.bringToFront();
  else await setPageHidden(page, false);
  await sleep(1000);
  const visibleAfterReturn = (await page.evaluate(() => document.visibilityState)) === "visible";
  const hud = await page.locator(".hud-leave").isVisible();
  const pass = visibilityWhileBackground === "hidden" && visibleAfterReturn && hud;
  return {
    pass,
    metrics: {
      "tab.hiddenMethod": native ? "native" : "synthetic",
      "tab.visibilityWhileBackground": visibilityWhileBackground,
      "tab.visibleAfterReturn": visibleAfterReturn,
      "tab.hudAfterReturn": hud,
    },
    detail: pass ? undefined : `background ${visibilityWhileBackground}, visible after return ${visibleAfterReturn}, hud ${hud}`,
  };
}

/**
 * The same account in two tabs of one context (one localStorage, one session): the second tab takes the
 * account's seat over, so the room lists each player once.
 */
async function sameAccountTabsCase(s, base) {
  prepare(s);
  const host = await signedIn(s, "host");
  const roomName = uniqueName("room");
  const code = await createRoom(host, base, roomName, { isPublic: true });
  const guest = await s.open("guest", { name: uniqueName("guest") });
  await joinByInvite(guest, base, code, roomName);
  const page = await host.context.newPage();
  const twin = { label: "host-tab2", context: host.context, page, ip: host.ip, problems: [] };
  // Same capture as Scenario.open: the browser's own font abort is not the page's error.
  page.on("pageerror", (err) => twin.problems.push(`${twin.label}: page error: ${err.message}`));
  page.on("console", (msg) => {
    if (msg.type() === "error" && !/downloadable font: download failed .*status=2152398850\b/.test(msg.text())) {
      twin.problems.push(`${twin.label}: console error: ${msg.text()}`);
    }
  });
  watchPage(twin);
  s.handles.push(twin);
  await joinByInvite(twin, base, code, roomName);
  await sleep(2000);
  const entries = await guest.page.locator(".room-player").count();
  const hostEntries = await guest.page.locator(".room-player").filter({ hasText: host.userName }).count();
  const pass = entries === 2 && hostEntries === 1;
  return {
    pass,
    metrics: { "twin.roomEntries": entries, "twin.hostEntries": hostEntries },
    detail: pass ? undefined : `room lists ${entries} entries, ${hostEntries} for the account (expected 2 and 1)`,
  };
}

/** An unknown room code: the player should be told the room does not exist. */
async function badRoomCase(s, base) {
  prepare(s);
  allowUrl = /\/ZZZZZZ(\?|$)/;
  // Self-test (QA_SELF_TEST=badroom): a real room's code stands in for the unknown one, so no "not found" is shown.
  const code = MODE === "badroom" ? await createRoom(await s.open("host", { name: uniqueName("host") }), base, uniqueName("room"), { isPublic: true }) : "ZZZZZZ";
  const h = await s.open("bad");
  await h.page.goto(`${base}/${code}`);
  await sleep(2000);
  const text = (await h.page.locator("body").innerText()).replace(/\s+/g, " ").trim();
  allowUrl = null;
  const told = /not found|doesn.t exist|no such room|couldn.t find|unknown room|isn.t available/i.test(text);
  return {
    pass: told,
    metrics: { "badroom.toldPlayer": told },
    detail: `shows: ${text.slice(0, 120)}`,
  };
}

const engines = selectedEngines();
const server = await startServer();
const base = server.base;

for (const engine of engines) {
  const browser = await launchEngine(engine);
  const results = new Results("robust", engine);
  const cdp = engine === "chromium";
  const opts = { browser, base };
  const noisy = { browser, base, ignore: [CONSOLE_OFFLINE] };

  if (MODE) {
    if (MODE === "badroom") await runCase(results, "badroom", (s) => badRoomCase(s, base), { ...opts, ignore: [CONSOLE_OFFLINE] });
    else await runCase(results, "boot.clean.webgl2", (s) => bootCase(s, base, "webgl2"), opts);
    results.save();
    await browser.close().catch(() => undefined);
    continue;
  }

  const gpu = cdp ? "webgpu" : "webgl2";
  if (cdp) {
    await runCase(results, "boot.clean.webgpu", (s) => bootCase(s, base, "webgpu"), opts);
  } else {
    await runCase(
      results,
      "boot.clean.webgpu",
      () => ({ detail: "skipped: WebGPU is chromium-only here; boot.clean.webgl2 covers the fallback" }),
      { ...opts, info: true },
    );
  }
  await runCase(results, "boot.clean.webgl2", (s) => bootCase(s, base, "webgl2"), opts);
  await runCase(results, "refresh.practice", (s) => refreshPracticeCase(s, base, gpu), opts);
  await runCase(results, "refresh.room", (s) => refreshRoomCase(s, base), opts);
  await runCase(results, "nav.backForward", (s) => backForwardCase(s, base, gpu), opts);
  await runCase(results, "resize.match", (s) => resizeMatchCase(s), opts);
  await runCase(results, "rotate.phone.practice", (s) => rotatePhoneCase(s, base, engine), opts);
  await runCase(results, "tab.switch.match", (s) => tabSwitchCase(s), opts);
  await runCase(results, "two.tabs.sameAccount.match", (s) => sameAccountTabsCase(s, base), opts);
  await runCase(results, "badroom", (s) => badRoomCase(s, base), { ...opts, ignore: [CONSOLE_OFFLINE] });
  await runCase(results, "reconnect.match", (s) => reconnectCase(s), noisy);
  await runCase(results, "net.offline20s.match", (s) => networkOffCase(s, cdp), noisy);
  await runCase(results, "net.blip4s.room", (s) => blipCase(s, cdp), noisy);
  await runCase(results, "net.giveUp60s.room", (s) => giveUpCase(s), noisy);
  await runCase(results, "offline.warm.j", (s) => offlineWarmCase(s, base, cdp, engine), { ...noisy, ignore: [CONSOLE_OFFLINE, OFFLINE_FETCH_NOISE] });
  const dying = await startServer();
  await runCase(results, "reconnect.givenUp.server", (s) => serverStopCase(s, dying), { ...noisy, base: dying.base });
  await runCase(results, "kicked.room", (s) => kickedCase(s), opts);
  await runCase(results, "app.closed.room", (s) => appClosedCase(s), opts);

  if (cdp) {
    await runCase(results, "net.slow3g.practice", (s) => slowNetCase(s, base, "webgpu"), opts);
  } else {
    await runCase(
      results,
      "net.slow3g.practice",
      () => ({ detail: "skipped: network profiles need CDP (chromium only)" }),
      { ...opts, info: true },
    );
  }

  results.save();
  await browser.close().catch(() => undefined);
}

writeIndex();
await runCleanups();
