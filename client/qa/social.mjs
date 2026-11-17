// Social QA instrument (round 0 extra): two clients, a room of N clients, the HUD ping badge,
// the Browse room count and presence latency. Every case starts a fresh server (startServer) and
// drives the real UI. Chromium runs all cases; firefox and webkit run the room flows and presence.
// The ping badge and Browse list are DOM-only checks, so they are chromium-only (N/A elsewhere).
//
// Keys (RUBRIC D17):
//   social.twoClient.pass      1 when two clients (distinct IPs) create, invite, join, start, play,
//                              leave, and show the same players and scoreboard (names, kills, wins,
//                              lives) at each step.
//   social.multi.pass          1 when N = min(4, room capacity) clients do the same flow. Room
//                              capacity = the room's max_players (create-form default 8, clamped to
//                              the server's NEOBOX_MAX_PLAYERS, default 32; crates/server/src/hub.rs).
//   social.ping.error.ms       max |HUD ping badge - stats-overlay RTT| over a 3 s sample. Pass <= 10.
//                              The badge pingMs and the RTT row (engine rttMs) render in the same tick.
//                              social.ping.updateMs: ms from HUD shown until the badge shows a number.
//   social.roomList.counts.ok  1 when the Browse list shows the server's public room count (rows and
//                              "N open") and excludes the private room.
//   social.presence.latencyMs  max(join, leave): guest's WebSocket send to the host's roster update.
//                              Pass <= 1000.
//
// Usage:  cd client && QA_OUT=C:/Users/aggressivecombo/neobox-scratch/qa/round0-extra node qa/social.mjs
//         (QA_ENGINES=chromium narrows the engines)
// Self-test (QA_SELF_TEST=<mode>; only that key's case runs, with a fault that must FAIL it):
//   twoclient  the guest never joins the host's room                     -> twoClient.pass 0
//   multi      the last of the N clients never joins                     -> multi.pass 0
//   ping       the HUD ping badge pinned to "250 ms" by a DOM observer   -> ping.error.ms > 10
//   roomcount  a phantom room card appended to the Browse list           -> roomList.counts.ok 0
//   presence   the host's inbound WebSocket messages delayed 1500 ms     -> presence latency > 1000

import {
  Results,
  button,
  createRoom,
  joinByInvite,
  launchEngine,
  menuName,
  roomTitle,
  runCleanups,
  selectedEngines,
  selfTestMode,
  sleep,
  startMatch,
  startServer,
  uniqueName,
  writeIndex,
} from "./lib-qa.mjs";
import { ADMIN_PASSWORD, playFromMenu } from "../e2e/lib.mjs";

const mode = selfTestMode();
const gate = (key) => !mode || mode === key;
const CLIENT_CAP = 4;

// Admin API state (rooms with public flag, server max_players). lib's adminRoom only fetches one room.
const adminCookies = new Map();
async function adminState(base) {
  if (!adminCookies.has(base)) {
    const login = await fetch(`${base}/admin/api/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ password: ADMIN_PASSWORD }),
    });
    if (!login.ok) throw new Error(`admin login: HTTP ${login.status}`);
    adminCookies.set(base, (login.headers.get("set-cookie") ?? "").split(";")[0]);
  }
  const res = await fetch(`${base}/admin/api/state`, { headers: { cookie: adminCookies.get(base) } });
  if (!res.ok) throw new Error(`admin state: HTTP ${res.status}`);
  return res.json();
}

/** Copies the host's invite link and reads it back from the clipboard (matchWithGuest's path). */
async function copyInvite(host, expected) {
  await button(host.page, "Invite").click();
  let url = "";
  for (let i = 0; i < 50 && url !== expected; i++) {
    url = await host.page.evaluate(() => navigator.clipboard.readText());
    if (url !== expected) await sleep(100);
  }
  if (url !== expected) throw new Error(`invite link is "${url}", expected ${expected}`);
  return url;
}

/** Scoreboard rows of one page as "name|kills|wins|lives", sorted. Columns: Player, Team, Kills, Wins, Lives, Status. */
const board = async (page) => {
  // The scoreboard renders only while Tab is held (app.ts: showScores follows Tab in a match).
  await page.keyboard.down("Tab");
  try {
    return await page.locator(".hud-scores tbody tr").evaluateAll((rows) =>
      rows.map((r) => [r.cells[0], r.cells[2], r.cells[3], r.cells[4]].map((c) => c.textContent.trim()).join("|")).sort(),
    );
  } finally {
    await page.keyboard.up("Tab");
  }
};

/** Polls the scoreboards until all agree and list exactly the expected names. */
async function settleBoards(handles, expectNames) {
  let boards = [];
  for (let i = 0; i < 50; i++) {
    boards = await Promise.all(handles.map((h) => board(h.page)));
    const agree = boards.every((b) => JSON.stringify(b) === JSON.stringify(boards[0]));
    const names = boards[0].map((row) => row.split("|")[0]);
    if (agree && JSON.stringify(names) === JSON.stringify(expectNames)) return { ok: true, boards };
    await sleep(100);
  }
  return { ok: false, boards };
}

/** Leaves the room from the room screen (its Leave button) and waits for the browser to replace it. */
async function leaveRoom(h) {
  const leave = h.page.getByRole("button", { name: "Leave", exact: true });
  await leave.click();
  await leave.waitFor({ state: "detached" });
}

/**
 * One room: the host creates it, guests join through the invite link, the host starts, every
 * client presses a few keys, the scoreboards are compared, and everyone leaves. `dropLast` makes
 * the last guest never join (self-test). Never throws: `ok` false with `detail` on any failure.
 */
async function roomFlow(s, { clipboard, clients, dropLast }) {
  const out = { ok: false, detail: "", clients: 0, roomMax: null, serverMax: null };
  try {
    const hostName = uniqueName("host");
    const roomName = uniqueName("room");
    const host = await s.open("host", { name: hostName, clipboard });
    const code = await createRoom(host, s.base, roomName, { isPublic: true });
    const state = await adminState(s.base);
    const room = state.rooms.find((r) => r.code === code);
    out.roomMax = room.max_players;
    out.serverMax = state.server.max_players;
    const guestNames = [];
    const guests = [];
    for (let i = 0; i < clients(room.max_players) - 1; i++) {
      const name = uniqueName(`guest${i}`);
      guestNames.push(name);
      const g = await s.open(`guest${i}`, { name });
      if (dropLast && i === clients(room.max_players) - 2) continue;
      const url = clipboard ? await copyInvite(host, `${s.base}/${code}`) : `${s.base}/${code}`;
      await g.page.goto(url);
      await roomTitle(g.page, roomName).waitFor();
      await host.page.locator("li.room-player").filter({ hasText: name }).waitFor();
      guests.push(g);
    }
    await startMatch(host, guests);
    const all = [host, ...guests];
    for (const h of all) {
      for (const key of ["ArrowLeft", "ArrowRight", "ArrowUp"]) {
        await h.page.keyboard.press(key);
        await sleep(100);
      }
    }
    const expectNames = [hostName, ...guestNames].sort();
    const playing = await settleBoards(all, expectNames);
    // The guests' leave ends the match for the host (last player standing): Game over, then Back to room.
    for (const g of guests) {
      await g.page.locator(".hud-leave").click();
      await g.page.locator(".hud-leave").waitFor({ state: "detached" });
    }
    const afterLeave = await settleBoards([host], [hostName]);
    const back = host.page.getByRole("button", { name: "Back to room" });
    await back.waitFor({ timeout: 10000 });
    await back.click();
    out.clients = all.length + (dropLast ? 1 : 0);
    out.ok = playing.ok && afterLeave.ok;
    out.detail = out.ok
      ? `${expectNames.length} clients agree: ${JSON.stringify(playing.boards[0])}`
      : `playing boards ${JSON.stringify(playing.boards)}; after leave ${JSON.stringify(afterLeave.boards)}`;
    await leaveRoom(host);
  } catch (err) {
    const lines = err.message.split("\n");
    const waiting = lines.find((l) => l.includes("waiting for"));
    out.detail = lines[0] + (waiting ? ` (${waiting.trim()})` : "");
  }
  return out;
}

async function flowCase(s, key, opts) {
  const r = await roomFlow(s, opts);
  const metrics = { [key]: r.ok ? 1 : 0, "social.flow.clients": r.clients };
  if (key === "social.multi.pass") {
    metrics["social.multi.capacity"] = Math.min(CLIENT_CAP, r.roomMax ?? 0);
    metrics["social.multi.roomMax"] = r.roomMax;
    metrics["social.multi.serverMax"] = r.serverMax;
  }
  return { pass: r.ok, detail: r.detail, metrics };
}

const READ_STATS = () => {
  const badge = document.querySelector(".hud-link")?.lastElementChild?.textContent ?? "";
  const row = [...document.querySelectorAll(".hud-stat-row")].find((r) => r.querySelector(".hud-stat-label")?.textContent === "RTT");
  return { badge, rtt: row?.querySelector(".hud-stat-value")?.textContent ?? "" };
};
const FORCE_BADGE = () => {
  const span = document.querySelector(".hud-link")?.lastElementChild;
  const pin = () => {
    if (span.textContent !== "250 ms") span.textContent = "250 ms";
  };
  new MutationObserver(pin).observe(span, { childList: true, characterData: true, subtree: true });
  pin();
};

async function pingCase(s) {
  const host = await s.open("host", { name: uniqueName("ping") });
  await createRoom(host, s.base, uniqueName("room"), { isPublic: false });
  await startMatch(host, []);
  const { page } = host;
  const hudAt = Date.now();
  if (mode === "ping") await page.evaluate(FORCE_BADGE);
  await page.keyboard.press("F3");
  await page.locator(".hud-stats").waitFor({ state: "visible" });
  const samples = [];
  for (let i = 0; i < 30; i++) {
    samples.push({ at: Date.now(), ...(await page.evaluate(READ_STATS)) });
    await sleep(100);
  }
  const num = (t) => {
    const m = /^(\d+) ms$/.exec(t.trim());
    return m ? Number(m[1]) : null;
  };
  const pairs = samples
    .map((x) => ({ badge: num(x.badge), rtt: num(x.rtt) }))
    .filter((p) => p.badge !== null && p.rtt !== null);
  const numeric = samples.find((x) => num(x.badge) !== null);
  const updateMs = numeric ? numeric.at - hudAt : null;
  const errorMs = pairs.length ? Math.max(...pairs.map((p) => Math.abs(p.badge - p.rtt))) : null;
  const last = samples.at(-1);
  const pass = errorMs !== null && pairs.length >= 10 && errorMs <= 10 && updateMs !== null && updateMs <= 2000;
  return {
    pass,
    detail: `last badge "${last.badge}", RTT "${last.rtt}"; max diff ${errorMs} ms over ${pairs.length} samples; badge numeric ${updateMs} ms after HUD`,
    metrics: { "social.ping.error.ms": errorMs, "social.ping.updateMs": updateMs, "social.ping.samples": pairs.length },
  };
}

// Roster snapshots of the host page: `window.__roster` = [{ t, names }] on every change of the room's player list.
const ROSTER_HOOK = () => {
  window.__roster = [];
  const snap = () => {
    const names = [...document.querySelectorAll("li.room-player")].map((li) => li.textContent).join("|");
    const last = window.__roster[window.__roster.length - 1];
    if (!last || last.names !== names) window.__roster.push({ t: Date.now(), names });
  };
  new MutationObserver(snap).observe(document.body, { subtree: true, childList: true, characterData: true });
  snap();
};
// Guest's send times of join_room and leave_room (window.__sent).
const SEND_HOOK = () => {
  const send = WebSocket.prototype.send;
  WebSocket.prototype.send = function (data) {
    if (typeof data === "string") {
      const sent = window.__sent ?? {};
      if (!sent.join && data.includes('"t":"join_room"')) sent.join = Date.now();
      if (data.includes('"t":"leave_room"')) sent.leave = Date.now();
      window.__sent = sent;
    }
    return send.call(this, data);
  };
};
// The client sets `ws.onmessage` (net.ts); delaying every handler call by 1.5 s is the presence fault.
const DELAY_HOOK = () => {
  const desc = Object.getOwnPropertyDescriptor(WebSocket.prototype, "onmessage");
  Object.defineProperty(WebSocket.prototype, "onmessage", {
    configurable: true,
    get() {
      return this.__handler ?? null;
    },
    set(fn) {
      this.__handler = fn;
      desc.set.call(this, fn && ((ev) => setTimeout(() => fn.call(this, ev), 1500)));
    },
  });
};

async function presenceCase(s) {
  const guestName = uniqueName("guest");
  const roomName = uniqueName("room");
  const host = await s.open("host", { name: uniqueName("host") });
  if (mode === "presence") await host.context.addInitScript(DELAY_HOOK);
  const code = await createRoom(host, s.base, roomName, { isPublic: true });
  await host.page.evaluate(ROSTER_HOOK);
  const guest = await s.open("guest", { name: guestName });
  await guest.context.addInitScript(SEND_HOOK);
  await joinByInvite(guest, s.base, code, roomName);
  await host.page.waitForFunction((n) => window.__roster.some((r) => r.names.includes(n)), guestName);
  const joinSent = await guest.page.evaluate(() => window.__sent.join);
  const joinSeen = await host.page.evaluate((n) => window.__roster.find((r) => r.names.includes(n)).t, guestName);
  await button(guest.page, "Leave").click();
  const leaveSent = await guest.page.evaluate(() => window.__sent.leave);
  await host.page.waitForFunction(
    ([n, t]) => window.__roster.some((r) => r.t >= t && !r.names.includes(n)),
    [guestName, leaveSent],
  );
  const leaveSeen = await host.page.evaluate(
    ([n, t]) => window.__roster.find((r) => r.t >= t && !r.names.includes(n)).t,
    [guestName, leaveSent],
  );
  const joinMs = joinSeen - joinSent;
  const leaveMs = leaveSeen - leaveSent;
  const latency = Math.max(joinMs, leaveMs);
  return {
    pass: latency <= 1000,
    detail: `join ${joinMs} ms, leave ${leaveMs} ms`,
    metrics: { "social.presence.latencyMs": latency, "social.presence.joinMs": joinMs, "social.presence.leaveMs": leaveMs },
  };
}

async function roomListCase(s) {
  for (let i = 0; i < 3; i++) {
    const owner = await s.open(`owner${i}`, { name: uniqueName("own") });
    await createRoom(owner, s.base, uniqueName("room"), { isPublic: i < 2 });
  }
  const browser = await s.open("browser", { name: uniqueName("browse") });
  await browser.page.goto(s.base);
  await menuName(browser.page).waitFor();
  await playFromMenu(browser.page, null);
  const list = browser.page.locator('ul[aria-label="rooms"]');
  await list.waitFor();
  const items = list.locator("li.room-item");
  const serverPublic = (await adminState(s.base)).rooms.filter((r) => r.public).length;
  for (let i = 0; i < 50 && (await items.count()) !== serverPublic; i++) await sleep(100);
  if (mode === "roomcount") {
    await browser.page.evaluate(() => {
      const ul = document.querySelector('ul[aria-label="rooms"]');
      ul.appendChild(ul.querySelector("li.room-item").cloneNode(true));
    });
  }
  const ui = await items.count();
  const total = ((await browser.page.locator(".room-total").textContent()) ?? "").trim();
  const ok = ui === serverPublic && total === `${serverPublic} open`;
  return {
    pass: ok,
    detail: `UI lists ${ui} rows, "${total}"; server has ${serverPublic} public rooms`,
    metrics: { "social.roomList.counts.ok": ok ? 1 : 0, "social.roomList.uiCount": ui, "social.roomList.serverCount": serverPublic },
  };
}

/** A fresh server per case; the server's cleanup is registered by startServer. */
async function runCase(results, browser, id, fn, extra = {}) {
  const srv = await startServer();
  return results.case(id, fn, { browser, base: srv.base, ...extra });
}

for (const engine of selectedEngines()) {
  const browser = await launchEngine(engine);
  const results = new Results("social", engine);
  const chromium = engine === "chromium";

  if (gate("twoclient")) {
    await runCase(results, browser, "twoClient", (s) =>
      flowCase(s, "social.twoClient.pass", { clipboard: chromium, clients: () => 2, dropLast: mode === "twoclient" }),
    );
  }
  if (gate("multi")) {
    await runCase(results, browser, "multi", (s) =>
      flowCase(s, "social.multi.pass", {
        clipboard: chromium,
        clients: (roomMax) => Math.min(CLIENT_CAP, roomMax),
        dropLast: mode === "multi",
      }),
    );
  }
  if (gate("presence")) await runCase(results, browser, "presence", presenceCase);
  if (chromium && gate("ping")) await runCase(results, browser, "ping", pingCase);
  if (chromium && gate("roomcount")) await runCase(results, browser, "roomList", roomListCase);
  if (!chromium && !mode) {
    await results.case("ping", () => ({ detail: "N/A: HUD ping badge is DOM-only; chromium baseline" }), { info: true });
    await results.case("roomList", () => ({ detail: "N/A: Browse list count is DOM-only; chromium baseline" }), { info: true });
  }

  results.save();
}

writeIndex();
await runCleanups();
