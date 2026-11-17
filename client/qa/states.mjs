// Page states the instruments capture. Each state has `prepare(s)`, which builds the state on a
// QaScenario (capture.mjs; s.base is the server URL) and returns the handle whose page is measured.
// Flags: `fit` = the screen must fit the viewport without vertical scroll; `dialog` = a modal is open
// (focus-trap audit); `splash` = keep the phone splash (do not dismiss it before measuring).

import os from "node:os";
import path from "node:path";
import {
  ADMIN_PASSWORD,
  DESKTOP,
  PASSWORD,
  builtinMaps,
  button,
  createRoom,
  dismissPhoneSplash,
  dismissRotateGate,
  joinByInvite,
  matchWithGuest,
  menuName,
  navTo,
  playFromMenu,
  roomCode,
  roomTitle,
  signedIn,
  startMatch,
  uniqueName,
} from "../e2e/lib.mjs";

const state = (id, flags, prepare) => ({
  id,
  fit: Boolean(flags.fit),
  dialog: Boolean(flags.dialog),
  splash: Boolean(flags.splash),
  prepare,
});
/** Requests a state fails on purpose (offline, stubbed API): their failures are induced, not defects. */
const SERVER_PATH = /\/(api|ws|admin|internal|healthz)(\/|\?|$)/;
/** The app's socket to the server (api.ts: `/ws` on the server origin). Its failures are the fault a disconnect state simulates. */
const SOCKET_URL = /^wss?:\/\/[^/]+\/ws(\?|$)/;
/** Sound files are not in the app shell: their fetches fail offline. */
const SFX_FILE = /\/sfx\/.*\.mp3(\?|$)/;
const MUSIC_FILE = /\/music\/.*\.mp3(\?|$)/;

/** Guest on the home menu. A fresh phone device shows the welcome over it: dismissed, or the controls under it time out. */
async function guestHome(s, label = "anon") {
  const h = await s.open(label);
  await h.page.goto(s.base);
  await dismissPhoneSplash(h.page);
  await menuName(h.page).waitFor();
  return h;
}

/** Signed-in host in a fresh public room, with the host's first ping measured. The ping arrives after the room
 * opens: until then the badge is the muted "-", and then it takes a tier colour and width, which moves the contrast
 * and the focus walk. */
async function hostRoom(s) {
  const h = await signedIn(s, "host");
  const name = uniqueName("room");
  const code = await createRoom(h, s.base, name, { isPublic: true });
  await h.page.locator("li.room-player .room-ping:not(.is-none)").first().waitFor();
  return { h, code, name };
}

/** Signed-in host creates a public room with a password (createRoom has no password option). */
async function passwordRoom(s, name) {
  const h = await signedIn(s, "host");
  await playFromMenu(h.page, null);
  await button(h.page, "New room").click();
  await h.page.getByLabel("room name").fill(name);
  await h.page.locator('input[autocomplete="new-password"]').fill(PASSWORD);
  const pub = h.page.getByLabel("Public");
  if (!(await pub.isChecked())) await pub.click();
  await button(h.page, "Create room").click();
  await roomTitle(h.page, name).waitFor();
  return { h, code: await roomCode(h.page) };
}

/** An approved public map: a signed-in maker uploads a builtin map and an admin approves it, so it shows in Browse. */
async function approvedMap(s) {
  const maker = await signedIn(s, "maker");
  const map = (await builtinMaps(s.base))[0];
  const name = uniqueName("map");
  const { page } = maker;
  // Seeding only: the scenario viewport can be a phone-sized one where the upload controls sit below the fold.
  await page.setViewportSize(DESKTOP.viewport);
  await navTo(page, "Library");
  await page.getByRole("tab", { name: "Mine", exact: true }).or(button(page, "Mine")).first().click();
  await page.getByRole("button", { name: "Upload a map", exact: true }).click();
  await page.getByPlaceholder("Map name", { exact: true }).fill(name);
  await page.getByLabel("map code", { exact: true }).fill(map.code);
  await page.getByRole("radiogroup", { name: "Visibility", exact: true }).getByRole("radio", { name: "Public", exact: true }).click();
  await page.getByRole("button", { name: "Upload map", exact: true }).click();
  await page.locator("ul[aria-label=maps] li").filter({ hasText: name }).waitFor();
  const admin = await s.open("admin");
  // Seeding only, as the maker page: the admin page's sticky header covers the maps table on a short scenario viewport.
  await admin.page.setViewportSize(DESKTOP.viewport);
  await admin.page.goto(`${s.base}/admin`);
  await admin.page.locator("#pw").fill(ADMIN_PASSWORD);
  await button(admin.page, "Log in").click();
  await admin.page.getByRole("heading", { name: "Map approvals" }).waitFor();
  await admin.page.locator("table#maps tbody tr").filter({ hasText: name }).getByRole("button", { name: "Approve", exact: true }).click();
  await admin.page.getByText(`Approved ${name}.`).waitFor();
  return name;
}

/**
 * A two-player match, host on the returned handle. Scenario handles keep the guest for robustness counts. A portrait
 * phone gets the rotate gate, which is dismissed here (the state is the match); rotate-prompt keeps it up.
 */
const inMatch = (s, opts = {}) => matchWithGuest(s, { clipboard: false, ...opts });

/**
 * Plays a void-map match to its end: one life each, so the sim ends the match and awards XP and the post-game panel
 * opens for the host and the guest. "End match" is not used: it ends without an award. Mirrors the e2e levels scenario.
 */
async function playVoidMatch(s, host) {
  const roomName = uniqueName("room");
  const code = await createRoom(host, s.base, roomName, { isPublic: false });
  // A fresh device shows the phone welcome over the room; capture.mjs only dismisses it after the state returns.
  await dismissPhoneSplash(host.page);
  const guestName = uniqueName("guest");
  const guest = await s.open("guest", { name: guestName });
  await joinByInvite(guest, s.base, code, roomName);
  await host.page.locator("li.room-player").filter({ hasText: guestName }).waitFor();
  const { page } = host;
  await roomTab(host, "Match");
  await button(page, "Change map").click();
  await page.getByLabel("Map code or JSON", { exact: true }).fill('{"b":[],"j":[],"s":[{"1":15,"2":10},{"1":25,"2":10}],"p":[],"tu":[],"tc":[],"gp":[],"c":[],"set":{"3":40,"15":40,"16":25}}');
  await button(page, "Use code").click();
  await roomTab(host, "Chat");
  const chat = page.getByLabel("Chat message", { exact: true });
  await chat.fill("/mode 1");
  await chat.press("Enter");
  await chat.fill("/set objectiveLimit 1");
  await chat.press("Enter");
  await page.locator("div.room-chat-log").getByText("objectiveLimit: 1").waitFor();
  await button(page, "Start").click();
  await page.getByRole("dialog", { name: "Game over" }).waitFor({ timeout: 60_000 });
}

/** Opens a settings section from the menu. */
const settingsSection = (label) => async (s) => {
  const h = await guestHome(s);
  await navTo(h.page, "Settings");
  await h.page.locator(".settings-nav-item").filter({ hasText: label }).click();
  return h;
};

/** Clicks a room tab; the tab bar only exists at phone widths, so at other sizes the room page is measured as is. */
async function roomTab(h, label) {
  const tab = h.page.getByRole("tab", { name: label, exact: true });
  if (await tab.isVisible()) await tab.click();
  return h;
}

/** Opens a room-roster row's action menu for `who` and picks Report. */
async function openReport(h, who) {
  await h.page.locator("li.room-player").filter({ hasText: who }).getByRole("button", { name: `Actions for ${who}` }).click();
  await h.page.getByRole("menuitem", { name: "Report" }).click();
  await h.page.getByRole("dialog", { name: `Report ${who}` }).waitFor();
}

/** Records every WebSocket a page opens (window.__ws), so a state can drop the live socket as a server-side close would. */
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

/** Makes every page this scenario opens record its sockets; call before the first open. */
function trackSockets(s) {
  const openOriginal = s.open.bind(s);
  s.open = async (label, opts) => {
    const h = await openOriginal(label, opts);
    await h.context.addInitScript(TRACK_SOCKETS);
    return h;
  };
}

/** Closes the page's live sockets (code 4000), as a dropped connection does (robust.mjs does the same). */
async function dropSockets(page) {
  await page.evaluate(() => {
    for (const socket of window.__ws ?? []) if (socket.readyState === WebSocket.OPEN) socket.close(4000, "qa drop");
  });
}

/** Takes the handle's network down. Its console errors from then on are the state's own (audit.mjs `deliberate`). */
async function goOffline(h) {
  h.offline = true;
  await h.context.setOffline(true);
}

/**
 * Drops the host's socket while online, waits for the banner, then takes the network down so the reconnect cannot
 * finish and the banner stays. The order matters: offline first and then close(4000) leaves the close handshake waiting
 * for a server reply that never arrives, so no close event fires and the banner never shows (the flake).
 */
async function dropAndGoOffline(h, timeout) {
  // The dropped socket and its failed reconnects are the fault these states simulate (C07 exempts them by URL).
  h.expected = [SOCKET_URL];
  await dropSockets(h.page);
  await h.page.locator(".reconnect-banner").waitFor({ state: "visible", timeout });
  await goOffline(h);
}

/** A room with `max` player slots, created from the menu; returns its code (createRoom has no max option). */
async function createRoomMax(h, base, roomName, max) {
  const { page } = h;
  await page.goto(base);
  await menuName(page).waitFor();
  await playFromMenu(page, null);
  await button(page, "New room").click();
  await page.getByRole("heading", { name: "Create a room", exact: true }).waitFor();
  await page.getByLabel("room name", { exact: true }).fill(roomName);
  await page.getByLabel("Max players").fill(String(max));
  await button(page, "Create room").click();
  await roomTitle(page, roomName).waitFor();
  return roomCode(page);
}

/** Signed-in host and a guest in a running match of a two-slot room (full). The host is `host`. */
async function signedMatch(s) {
  const host = await signedIn(s, "host");
  const roomName = uniqueName("room");
  const code = await createRoomMax(host, s.base, roomName, 2);
  const guest = await s.open("guest", { name: uniqueName("guest") });
  await joinByInvite(guest, s.base, code, roomName);
  await host.page.locator("li.room-player").nth(1).waitFor();
  await startMatch(host, [guest]);
  return { host, guest, code };
}

export const STATES = [
  // Home and menus
  state("menu-anon", {}, async (s) => guestHome(s, "anon")),
  state("menu-user", {}, async (s) => signedIn(s, "user")),
  state("menu-news", { dialog: true }, async (s) => {
    const h = await guestHome(s);
    await button(h.page, "News").click();
    await h.page.getByRole("dialog").first().waitFor();
    return h;
  }),
  state("menu-quick", {}, async (s) => {
    const h = await guestHome(s);
    await playFromMenu(h.page, null, { quick: true });
    await h.page.getByText(/matching you/).waitFor({ timeout: 5000 }).catch(() => {});
    return h;
  }),
  state("menu-standalone", {}, async (s) => {
    // The home menu from the manifest start_url, as an installed app opens it. The display mode is probed as it is.
    const h = await s.open("anon");
    await h.page.goto(s.base);
    const href = await h.page.locator('link[rel="manifest"]').getAttribute("href");
    const manifestUrl = new URL(href, s.base).href;
    const res = await h.context.request.get(manifestUrl);
    if (!res.ok()) throw new Error(`manifest ${manifestUrl}: HTTP ${res.status()}`);
    const { start_url: startUrl } = await res.json();
    await h.page.goto(new URL(startUrl ?? "/", manifestUrl).href);
    await menuName(h.page).waitFor();
    h.info = { displayModeStandalone: await h.page.evaluate(() => window.matchMedia("(display-mode: standalone)").matches) };
    return h;
  }),

  // Browse, create, join
  state("browse", {}, async (s) => {
    const h = await guestHome(s);
    await playFromMenu(h.page, null);
    await button(h.page, "New room").waitFor();
    return h;
  }),
  state("empty-browser", {}, async (s) => {
    // The server is shared by the sweep, so rooms accumulate: the room list the server pushes ("rooms" over the
    // WebSocket) is rewritten to an empty list for this page only.
    const h = await s.open("anon");
    await h.page.routeWebSocket(/.*/, (ws) => {
      const server = ws.connectToServer();
      ws.onMessage((msg) => server.send(msg));
      server.onMessage((msg) => {
        if (typeof msg === "string" && msg.includes('"t":"rooms"')) {
          ws.send(JSON.stringify({ ...JSON.parse(msg), rooms: [] }));
        } else ws.send(msg);
      });
    });
    await h.page.goto(s.base);
    await menuName(h.page).waitFor();
    await playFromMenu(h.page, null);
    await h.page.getByText("No open rooms right now").waitFor();
    return h;
  }),
  state("offline-load", {}, async (s) => {
    // Loaded online, then the network goes down and the page reloads: the service worker (sw.js, app shell precached)
    // serves the page, and the server paths fail as they do with the server unreachable.
    const h = await s.open("anon");
    // Sound files are not in the app shell: their fetches fail offline, and the app logs the failure it caught.
    h.expected = [SERVER_PATH, SFX_FILE, MUSIC_FILE, /\/sw\.js(\?|$)/];
    // The offline reload re-checks the worker script, which cannot be fetched; the sound files fail too, and the app logs it.
    h.expectedWarnings = [/Sound effects failed to load: TypeError: Failed to fetch/, /Failed to register a ServiceWorker .* fetching the script/, /service worker update: TypeError: Script .* load failed/];
    await h.page.goto(s.base);
    await menuName(h.page).waitFor();
    // The first visit installs the worker; activate claims the page, so wait until it controls the page.
    await h.page.waitForFunction(() => navigator.serviceWorker.controller !== null, null, { timeout: 30_000 });
    await goOffline(h);
    await h.page.reload();
    await menuName(h.page).waitFor();
    await navTo(h.page, "Library");
    await h.page.getByRole("heading", { name: "You are offline", exact: true }).waitFor();
    return h;
  }),
  state("create-room", { dialog: true }, async (s) => {
    const h = await guestHome(s);
    await playFromMenu(h.page, null);
    await button(h.page, "New room").click();
    await h.page.getByRole("heading", { name: "Create a room", exact: true }).waitFor();
    return h;
  }),
  state("password-prompt-list", { dialog: true }, async (s) => {
    const name = uniqueName("pw");
    await passwordRoom(s, name);
    const g = await guestHome(s, "guest");
    await playFromMenu(g.page, null);
    await g.page.locator("li.room-item").filter({ hasText: name }).click();
    await g.page.locator("input.join-password").waitFor();
    return g;
  }),
  state("password-prompt-invite", { dialog: true }, async (s) => {
    const { code } = await passwordRoom(s, uniqueName("pw"));
    const g = await guestHome(s, "guest");
    await g.page.goto(`${s.base}/${code}`);
    await g.page.getByRole("heading", { name: /needs a password/ }).waitFor();
    return g;
  }),
  state("error-toast", {}, async (s) => {
    // A full room's code typed into Join: the server refuses with room_full, and the browser keeps the cause on screen as an alert (app.ts).
    const host = await signedIn(s, "host");
    const code = await createRoomMax(host, s.base, uniqueName("room"), 1);
    const h = await guestHome(s);
    await playFromMenu(h.page, null);
    await h.page.getByLabel("Room code").fill(code);
    await button(h.page, "Join").click();
    await h.page.getByRole("alert").filter({ hasText: "The room is full" }).waitFor();
    return h;
  }),
  state("error-404-room", { dialog: true }, async (s) => {
    // Invite link to a code that is not open: the "Room not found" modal, with Browse rooms.
    const h = await s.open("guest", { name: uniqueName("guest") });
    // Mark the phone welcome seen so the "Room not found" modal is the only dialog over the page.
    await h.context.addInitScript(() => localStorage.setItem("neobox.phoneSplashSeen", "1"));
    await h.page.goto(`${s.base}/AAAAAA`);
    await h.page.getByText("Room not found", { exact: true }).waitFor();
    await button(h.page, "Browse rooms").waitFor();
    return h;
  }),
  state("error-api", {}, async (s) => {
    // The server's map list (/api/maps) fails and so does the bundled fallback (/offline-maps.json): both HTTP 500.
    const h = await s.open("anon", { serviceWorkers: "block" });
    // The failures are injected in the page's fetch: WebKit does not reliably apply context routes to these requests.
    await h.context.addInitScript(() => {
      const real = window.fetch.bind(window);
      window.fetch = (input, init) => {
        const url = typeof input === "string" ? input : input instanceof Request ? input.url : String(input);
        if (/\/(api\/maps|offline-maps\.json)(\?|$)/.test(url)) return Promise.resolve(new Response("server error", { status: 500, headers: { "content-type": "text/plain" } }));
        return real(input, init);
      };
    });
    await h.page.goto(s.base);
    await menuName(h.page).waitFor();
    await navTo(h.page, "Practice");
    await h.page.locator(".offline-error").getByText("Could not load maps", { exact: false }).waitFor();
    return h;
  }),

  // Room: host, phone tabs, pickers, report, profile, reconnect
  state("room-host", {}, async (s) => (await hostRoom(s)).h),
  state("room-tab-players", {}, async (s) => roomTab((await hostRoom(s)).h, "Players")),
  state("room-tab-match", {}, async (s) => roomTab((await hostRoom(s)).h, "Match")),
  state("room-tab-chat", {}, async (s) => roomTab((await hostRoom(s)).h, "Chat")),
  state("picker-mode", { dialog: true }, async (s) => {
    const h = await roomTab((await hostRoom(s)).h, "Match");
    await button(h.page, "Change mode").click();
    await h.page.getByRole("dialog", { name: "Game mode" }).waitFor();
    return h;
  }),
  state("picker-map", { dialog: true }, async (s) => {
    const h = await roomTab((await hostRoom(s)).h, "Match");
    await button(h.page, "Change map").click();
    await h.page.getByRole("dialog", { name: "Choose a map" }).waitFor();
    return h;
  }),
  state("picker-library", { dialog: true }, async (s) => {
    const h = await roomTab((await hostRoom(s)).h, "Match");
    await button(h.page, "Change map").click();
    await button(h.page, "Library").click();
    await h.page.getByRole("dialog", { name: "Pick a map" }).waitFor();
    return h;
  }),
  state("picker-colour", { dialog: true }, async (s) => {
    const { h } = await hostRoom(s);
    await h.page.getByRole("button", { name: "Appearance", exact: true }).click();
    await h.page.getByRole("dialog", { name: "Appearance colour" }).waitFor();
    return h;
  }),
  state("report", { dialog: true }, async (s) => {
    const { h, code, name } = await hostRoom(s);
    const g = await signedIn(s, "guest");
    await joinByInvite(g, s.base, code, name);
    await h.page.locator("li.room-player").filter({ hasText: g.userName }).waitFor();
    await openReport(h, g.userName);
    return h;
  }),
  state("profile", { dialog: true }, async (s) => {
    const { h } = await hostRoom(s);
    await h.page.locator(".room-profile-link").first().click();
    await h.page.getByRole("dialog").filter({ hasText: "Profile" }).waitFor();
    return h;
  }),
  state("reconnecting", {}, async (s) => {
    // As match-disconnected: the network stays down, so the dropped socket cannot reconnect and the banner stays.
    trackSockets(s);
    const { h } = await hostRoom(s);
    await dropAndGoOffline(h, 20_000);
    return h;
  }),
  state("room-full", {}, async (s) => {
    // Real server path: a one-slot room is full for the joiner (room_full, shown as an error toast).
    const host = await signedIn(s, "host");
    const code = await createRoomMax(host, s.base, uniqueName("room"), 1);
    const guest = await s.open("guest", { name: uniqueName("guest") });
    await guest.page.goto(`${s.base}/${code}`);
    await guest.page.getByRole("alert").filter({ hasText: "The room is full" }).waitFor();
    return guest;
  }),
  state("toast-invite", {}, async (s) => {
    // Copy invite link on the room page (the invite toast is shown there, not on the menu).
    const host = await s.open("host", { name: uniqueName("host"), clipboard: s.env.browser.clipboard });
    await createRoom(host, s.base, uniqueName("room"), { isPublic: true });
    await button(host.page, "Invite").click();
    // Without clipboard permission (Firefox, WebKit) the app shows the link itself in the toast (room.ts shareInvite).
    await host.page.locator("#toasts").getByText(/Invite link copied\.|https?:\/\//).first().waitFor();
    return host;
  }),

  // Match
  state("match-running", { fit: true }, async (s) => {
    const { host } = await inMatch(s);
    // The capture is the match: wait for the HUD leave control, and for the menu to be gone.
    await host.page.locator(".hud-leave").waitFor({ state: "visible" });
    await menuName(host.page).waitFor({ state: "hidden" });
    return host;
  }),
  state("match-hud", { fit: true }, async (s) => (await inMatch(s)).host),
  state("match-menu", { fit: true }, async (s) => {
    const { host } = await inMatch(s);
    await button(host.page, "Menu").click();
    await host.page.locator("#hud-menu").waitFor();
    return host;
  }),
  state("scoreboard", { fit: true }, async (s) => {
    const { host } = await inMatch(s);
    await host.page.keyboard.down("Tab");
    await host.page.locator(".hud-scores").waitFor();
    return host;
  }),
  state("postgame", { fit: true, dialog: true }, async (s) => {
    const host = await s.open("host", { name: uniqueName("host") });
    await playVoidMatch(s, host);
    return host;
  }),
  state("postgame-user", { fit: true, dialog: true }, async (s) => {
    const host = await signedIn(s, "user");
    await playVoidMatch(s, host);
    return host;
  }),
  state("rotate-prompt", { dialog: true }, async (s) => {
    const { host } = await inMatch(s, { keepRotateGate: true });
    await host.page.getByRole("dialog", { name: "Turn your phone sideways" }).waitFor({ timeout: 4000 }).catch(() => {});
    return host;
  }),
  state("match-disconnected", {}, async (s) => {
    // Playwright cannot send a 1006 close from page script, so the socket is dropped as robust.mjs does;
    // then the network stays down so the reconnect cannot finish. "Retry now" cannot connect while offline; Leave is the exit.
    trackSockets(s);
    const { host } = await inMatch(s);
    await dropAndGoOffline(host, 10_000);
    await dismissRotateGate(host.page);
    return host;
  }),
  state("offline-match", {}, async (s) => {
    // The socket drops, the banner must show within 3 s, then the network goes down so it stays.
    trackSockets(s);
    const { host } = await inMatch(s);
    await dropAndGoOffline(host, 3000);
    return host;
  }),
  state("match-kicked", {}, async (s) => {
    // The roster (where Kick lives) is only mounted in the lobby, so no host kick can be made mid-match. The
    // client receives the server's kick message on the guest's socket instead, and handles it as usual.
    trackSockets(s);
    const { guest } = await inMatch(s);
    await guest.page.evaluate(() => {
      const socket = window.__ws.find((ws) => ws.readyState === WebSocket.OPEN);
      socket.dispatchEvent(new MessageEvent("message", { data: JSON.stringify({ t: "kicked", reason: "You were kicked" }) }));
    });
    await guest.page.getByRole("alert").filter({ hasText: "You were kicked" }).waitFor();
    return guest;
  }),
  state("match-full", {}, async (s) => {
    // Real server path: the room has two slots and a match is running; a third client's join is refused (room_full).
    const { code } = await signedMatch(s);
    const late = await s.open("late", { name: uniqueName("late") });
    await late.page.goto(`${s.base}/${code}`);
    await late.page.getByRole("alert").filter({ hasText: "The room is full" }).waitFor();
    return late;
  }),

  // Solo modes
  state("training", { fit: true }, async (s) => {
    const h = await guestHome(s);
    await navTo(h.page, "Training");
    await h.page.locator(".training-text").waitFor({ state: "attached" });
    await dismissRotateGate(h.page);
    await h.page.locator(".training-text").waitFor();
    return h;
  }),
  state("practice-setup", {}, async (s) => {
    const h = await guestHome(s);
    await navTo(h.page, "Practice");
    await h.page.locator(".offline-list .offline-choice").first().waitFor();
    return h;
  }),
  state("practice-running", { fit: true }, async (s) => {
    const h = await guestHome(s);
    await navTo(h.page, "Practice");
    await h.page.locator(".offline-list .offline-choice").first().click();
    await button(h.page, "Start").click();
    await h.page.locator(".offline.playing").waitFor();
    await dismissRotateGate(h.page);
    return h;
  }),
  state("replay-empty", {}, async (s) => {
    const h = await guestHome(s);
    await navTo(h.page, "Replay");
    await h.page.locator('input[type="file"]').first().waitFor();
    return h;
  }),
  state("replay-loaded", { fit: true }, async (s) => {
    const { host } = await inMatch(s);
    // End match opens the app's confirm dialog; the ended match then shows "Save replay" in the room lobby.
    await host.page.locator(".hud-end").click();
    const endDialog = host.page.getByRole("alertdialog", { name: "End the match?", exact: true });
    await endDialog.getByRole("button", { name: "End match", exact: true }).click();
    await button(host.page, "Save replay").waitFor();
    const [download] = await Promise.all([host.page.waitForEvent("download"), button(host.page, "Save replay").click()]);
    const file = path.join(os.tmpdir(), `neobox-qa-${Date.now()}-${download.suggestedFilename()}`);
    await download.saveAs(file);
    await host.page.goto(s.base);
    await menuName(host.page).waitFor();
    await navTo(host.page, "Replay");
    await host.page.locator('input[type="file"]').first().setInputFiles(file);
    await host.page.locator(".offline.playing").waitFor();
    return host;
  }),

  // Map editor
  state("editor-empty", { fit: true }, async (s) => {
    const h = await signedIn(s, "user");
    await navTo(h.page, "Map editor");
    await h.page.locator("canvas.editor-canvas").waitFor();
    return h;
  }),
  state("editor-shapes", { fit: true }, async (s) => {
    const h = await signedIn(s, "user");
    await navTo(h.page, "Map editor");
    const canvas = h.page.locator("canvas.editor-canvas");
    await canvas.waitFor();
    const box = await canvas.boundingBox();
    const cx = box.x + box.width / 2;
    const cy = box.y + box.height / 2;
    for (const dx of [0, 150]) {
      await button(h.page, "Box").click();
      await h.page.mouse.move(cx + dx - 80, cy - 50);
      await h.page.mouse.down();
      await h.page.mouse.move(cx + dx + 80, cy + 50, { steps: 8 });
      await h.page.mouse.up();
    }
    return h;
  }),

  // Settings, about, privacy
  state("settings", {}, async (s) => {
    const h = await guestHome(s);
    await navTo(h.page, "Settings");
    await h.page.locator(".settings-nav-item").first().waitFor();
    return h;
  }),
  state("settings-controls", {}, settingsSection("Controls")),
  state("settings-touch", {}, settingsSection("Touch")),
  state("settings-sound", {}, settingsSection("Sound")),
  state("settings-display", {}, settingsSection("Display")),
  state("settings-chat", {}, settingsSection("Chat")),
  state("about", {}, async (s) => {
    const h = await guestHome(s);
    await navTo(h.page, "About");
    return h;
  }),
  state("privacy", {}, async (s) => {
    const h = await guestHome(s);
    await navTo(h.page, "About");
    await button(h.page, "Privacy").click();
    return h;
  }),

  // Account and friends
  state("account-guest", {}, async (s) => {
    const h = await guestHome(s);
    await h.page.locator(".home-account").click();
    await h.page.locator(".account-form").waitFor();
    return h;
  }),
  state("account-user", {}, async (s) => {
    const h = await signedIn(s, "user");
    await h.page.locator(".home-account").click();
    await button(h.page, "Sign out").waitFor();
    return h;
  }),
  state("account-security", {}, async (s) => {
    const h = await signedIn(s, "user");
    // A fresh phone device shows the welcome over the menu after sign-in; it covers the account button and the security summary.
    await dismissPhoneSplash(h.page);
    await h.page.locator(".home-account").click();
    await h.page.locator("details.account-security summary").click();
    return h;
  }),
  state("friends-empty", {}, async (s) => {
    const h = await signedIn(s, "user");
    await navTo(h.page, "Friends");
    await h.page.getByText("No friends yet").waitFor();
    return h;
  }),
  state("friends-requests", {}, async (s) => {
    const a = await signedIn(s, "a");
    const b = await signedIn(s, "b");
    await navTo(a.page, "Friends");
    await a.page.getByLabel("friend's name").fill(b.userName);
    await button(a.page, "Send request").click();
    await b.page.reload();
    await navTo(b.page, "Friends");
    await b.page.getByText("Requests", { exact: true }).waitFor();
    return b;
  }),

  // Library
  state("library-grid", {}, async (s) => {
    // Browse lists approved public maps: approve one first so the capture shows the populated list (empty-library covers "No maps yet").
    const name = await approvedMap(s);
    const h = await signedIn(s, "user");
    await navTo(h.page, "Library");
    await h.page.getByLabel("search maps").waitFor();
    await h.page.locator("ul[aria-label=maps]").waitFor({ state: "attached" });
    await h.page.locator("ul[aria-label=maps] li").filter({ hasText: name }).first().waitFor();
    // The makers panel fills from its own fetch; wait for the list or the status line it sets.
    await h.page.waitForFunction(() => {
      const panel = document.querySelector('[aria-label="top makers this week"]');
      return panel !== null && (panel.querySelector("li") !== null || panel.querySelector("p.status")?.textContent !== "");
    });
    return h;
  }),
  state("library-map-dialog", { dialog: true }, async (s) => {
    const name = await approvedMap(s);
    const h = await guestHome(s);
    await navTo(h.page, "Library");
    await h.page.locator("ul[aria-label=maps] li").filter({ hasText: name }).first().locator("button.map-card").click();
    await h.page.locator(".map-dialog").waitFor();
    return h;
  }),

  state("empty-library", {}, async (s) => {
    const h = await signedIn(s, "user");
    await navTo(h.page, "Library");
    await h.page.getByRole("tab", { name: "Mine", exact: true }).click();
    await h.page.getByText("No maps yet").waitFor();
    return h;
  }),

  // Phone-only overlays (shown by the page at touch sizes)
  state("phone-splash", { dialog: true, splash: true }, async (s) => {
    const h = await s.open("phone");
    await h.page.goto(s.base);
    await h.page.getByRole("dialog", { name: "Welcome" }).waitFor({ timeout: 5000 }).catch(() => {});
    return h;
  }),
];

export const stateById = (id) => {
  const found = STATES.find((st) => st.id === id);
  if (!found) throw new Error(`unknown state "${id}" (known: ${STATES.map((st) => st.id).join(", ")})`);
  return found;
};
