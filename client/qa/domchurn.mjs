// DOM churn probe: counts focusable controls that are replaced (removed and not re-attached in the same
// tick) while a screen sits idle, and checks that keyboard focus survives broadcasts and refreshes. Screens:
// the menu, friends, quick play, library (Browse, Mine, Favourites), settings, the room (broadcasts about
// once a second while not in a match), the room browser, the admin page, and the match HUD with its pause menu.
//
// Usage: `bun qa/domchurn.mjs [--engine firefox] [--idle 10]` with NEOBOX_DIST (or --dist) set.
// `--idle` is the floor for each idle window; windows span at least one timed refresh (friends 15 s, quick play 30 s).
// Exit status: 0 when every idle window replaced 0 focusable controls and focus survived, 1 otherwise.

import { button, createRoom, DESKTOP, launchEngine, menuName, roomTitle, runCleanups, sleep, startServer, uniqueName } from "./lib-qa.mjs";
import { ADMIN_PASSWORD, joinByInvite, nextClientIp, signUp, startMatch, navTo } from "../e2e/lib.mjs";

const arg = (flag, fallback) => {
  const i = process.argv.indexOf(flag);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
};
const ENGINE = arg("--engine", "firefox");
const IDLE_S = Number(arg("--idle", "10"));
const SETTLE_MS = 2000; // screen transitions (dialog close, menu teardown) finish before the idle window counts
const FOCUS_MS = 5000;

const FOCUSABLE = "button,input,select,textarea,a[href],[tabindex]:not([tabindex='-1'])";

/** Installs the observer that records focusable nodes removed and not re-attached (a true replacement). */
async function startWatch(page) {
  await page.evaluate((focusable) => {
    window.__churnObs?.disconnect();
    window.__churn = { replaced: [], observed: 0 };
    const pending = [];
    const flush = () => {
      for (const el of pending.splice(0)) {
        if (!el.isConnected) {
          window.__churn.replaced.push({
            tag: el.tagName.toLowerCase(),
            key: el.dataset?.focusKey ?? null,
            text: (el.textContent ?? "").trim().slice(0, 40),
            aria: el.getAttribute("aria-label"),
          });
        }
      }
    };
    window.__churnObs = new MutationObserver((records) => {
      for (const rec of records) {
        for (const node of rec.removedNodes) {
          if (!(node instanceof Element)) continue;
          if (node.matches(focusable)) pending.push(node);
          for (const el of node.querySelectorAll(focusable)) pending.push(el);
        }
        window.__churn.observed++;
      }
      queueMicrotask(flush);
    });
    window.__churnObs.observe(document.body, { childList: true, subtree: true });
  }, FOCUSABLE);
}

/** Settles the screen, then runs an idle window and returns the number of replaced focusable controls. */
async function idleWindow(page, label, seconds = IDLE_S) {
  await sleep(SETTLE_MS);
  await startWatch(page);
  await sleep(seconds * 1000);
  const { replaced, observed } = await page.evaluate(() => window.__churn);
  console.log(`[${label}] idle ${seconds}s: replaced focusable controls ${replaced.length}, mutation records ${observed}`);
  for (const r of replaced.slice(0, 10)) console.log(`  - ${r.tag} key=${r.key} aria=${r.aria} text="${r.text}"`);
  return replaced.length;
}

/** Focuses a control and checks that it is still the same connected, focused node after `ms`. */
async function focusSurvives(page, label, locator, ms = FOCUS_MS) {
  await locator.focus();
  await page.evaluate(() => {
    window.__focused = document.activeElement;
  });
  await sleep(ms);
  const ok = await page.evaluate(() => document.activeElement === window.__focused && window.__focused.isConnected);
  console.log(`[focus] ${label}: ${ok ? "kept" : "LOST"} after ${ms / 1000}s of broadcasts`);
  return ok;
}

/** A page with its own browser context and client address; `account` signs a new account in on the menu. */
async function openPage(browser, base, account) {
  const page = await browser.newPage({ viewport: DESKTOP.viewport });
  const name = account ? uniqueName(account) : null;
  if (name) {
    await signUp({ context: page.context(), ip: nextClientIp() }, base, name);
  }
  await page.goto(base);
  await menuName(page).waitFor();
  return { page, name };
}

/** Runs one screen's checks on a fresh page and closes it. Failures are recorded, not thrown, so later screens still run. */
async function section(results, key, fn) {
  try {
    await fn();
  } catch (err) {
    console.log(`[${key}] ERROR ${err.message}`);
    results[`${key}:error`] = false;
  }
}

const results = {};
const server = await startServer();
const browser = await launchEngine(ENGINE);
const base = server.base;
try {
  // Menu: the account button and the players-online line refresh while the menu sits idle.
  await section(results, "menu", async () => {
    const { page } = await openPage(browser, base, null);
    results.menu = await idleWindow(page, "menu", 12);
    results.menuFocus = await focusSurvives(page, "menu drum", page.getByRole("listbox", { name: "Destinations", exact: true }));
    await page.close();
  });

  // Friends: two accounts become friends; B sits in a room so A's friend row carries "in <room>". A's list refreshes every 15 s.
  await section(results, "friends", async () => {
    const a = await openPage(browser, base, "alice");
    const b = await openPage(browser, base, "bob");
    await navTo(a.page, "Friends");
    await a.page.getByLabel("friend's name", { exact: true }).fill(b.name);
    await button(a.page, "Send request").click();
    await a.page.getByText(`Request sent to ${b.name}.`).waitFor();
    await navTo(b.page, "Friends");
    const incoming = b.page.locator("li.friend-row").filter({ hasText: a.name }).first();
    await incoming.waitFor();
    await incoming.getByRole("button", { name: "Accept", exact: true }).click();
    await b.page.getByText(`You are now friends with ${a.name}.`).waitFor();
    const roomName = uniqueName("fr");
    await createRoom({ page: b.page }, base, roomName, { isPublic: true });
    await a.page.goto(base);
    await menuName(a.page).waitFor();
    await navTo(a.page, "Friends");
    const row = a.page.locator("li.friend-row").filter({ hasText: b.name }).filter({ hasText: `in ${roomName}` }).first();
    await row.waitFor();
    results.friends = await idleWindow(a.page, "friends", 20);
    results.friendsJoinFocus = await focusSurvives(a.page, "friends Join", row.getByRole("button", { name: "Join", exact: true }));
    await a.page.close();
    await b.page.close();
  });

  // Quick play: the mode cards refresh every 30 s; the carousel steps on its own buttons.
  await section(results, "quick", async () => {
    const { page } = await openPage(browser, base, null);
    await menuName(page).fill(uniqueName("qd"));
    await navTo(page, "Quick play");
    await page.getByRole("heading", { name: "Quick play", exact: true }).waitFor();
    await page.locator(".quick-card", { hasText: "Sweaty Bois" }).getByText(/\d+ playing/).waitFor();
    results.quick = await idleWindow(page, "quick play", 35);
    results.quickCarouselFocus = await focusSurvives(
      page,
      "quick Next map",
      page.locator(".quick-card", { hasText: "Sweaty Bois" }).getByRole("button", { name: "Next Sweaty Bois map" }),
    );
    await page.close();
  });

  // Library: Browse (the public grid), Mine and Favourites (signed in). Each tab is idle on its own.
  await section(results, "library", async () => {
    const { page } = await openPage(browser, base, "lib");
    await navTo(page, "Library");
    for (const tab of ["Browse", "Mine", "Favourites"]) {
      const t = page.getByRole("tab", { name: tab, exact: true }).or(button(page, tab)).first();
      await t.click();
      results[`library${tab}`] = await idleWindow(page, `library ${tab}`);
    }
    results.libraryTabFocus = await focusSurvives(page, "library Favourites tab", page.getByRole("tab", { name: "Favourites", exact: true }).or(button(page, "Favourites")).first());
    await page.close();
  });

  // Settings: the rebinding list and the touch layout sit idle; no timers are expected.
  await section(results, "settings", async () => {
    const { page } = await openPage(browser, base, null);
    await navTo(page, "Settings");
    results.settings = await idleWindow(page, "settings");
    results.settingsFocus = await focusSurvives(page, "settings Jump key", page.getByRole("button", { name: /^Jump key/ }).first());
    await page.close();
  });

  // Room: a host alone in a public room. The room re-renders on every broadcast.
  await section(results, "room", async () => {
    const { page } = await openPage(browser, base, null);
    const roomName = uniqueName("dc");
    const code = await createRoom({ page }, base, roomName, { isPublic: true });
    await roomTitle(page, roomName).waitFor();
    results.room = await idleWindow(page, "room");
    results.roomInviteFocus = await focusSurvives(page, "room Invite", page.locator("[data-focus-key=invite]"));

    // Browse: the room list with the room above. Focus its row and check it survives.
    const guest = await openPage(browser, base, null);
    await navTo(guest.page, "Browse rooms");
    const row = guest.page.locator("button.room-row").filter({ hasText: roomName });
    await row.waitFor();
    results.browse = await idleWindow(guest.page, "browse");
    results.browseRowFocus = await focusSurvives(guest.page, "browse room row", row);
    await guest.page.close();

    // Admin: log in, select the room, then sit on the tables that refresh every second.
    const admin = await browser.newPage({ viewport: DESKTOP.viewport });
    await admin.goto(`${base}/admin`);
    await admin.locator("#pw").fill(ADMIN_PASSWORD);
    await button(admin, "Log in").click();
    await admin.getByRole("heading", { name: "Map approvals" }).waitFor();
    await admin.locator("#rooms tbody tr").filter({ hasText: code }).click();
    await admin.locator("#players tbody button").first().waitFor();
    results.admin = await idleWindow(admin, "admin");
    results.adminPlayerFocus = await focusSurvives(admin, "admin player Host", admin.locator("#players tbody button").first());
    await admin.close();
    await page.close();
  });

  // Match: a host and a guest in a running match. The HUD idles, then the pause menu idles with its focus kept.
  await section(results, "match", async () => {
    const host = await openPage(browser, base, null);
    const guest = await openPage(browser, base, null);
    const roomName = uniqueName("mt");
    const code = await createRoom({ page: host.page }, base, roomName, { isPublic: true });
    await joinByInvite({ page: guest.page }, base, code, roomName);
    await roomTitle(guest.page, roomName).waitFor();
    await startMatch({ page: host.page }, [{ page: guest.page }]);
    results.hud = await idleWindow(host.page, "match HUD");
    results.hudMenuFocus = await focusSurvives(host.page, "HUD Menu", button(host.page, "Menu"));
    await button(host.page, "Menu").click();
    results.pause = await idleWindow(host.page, "pause menu");
    results.pauseFocus = await focusSurvives(host.page, "pause Show lobby", button(host.page, "Show lobby"));
    await button(host.page, "Show lobby").click();
    await button(host.page, "Back to game").click();
    await host.page.close();
    await guest.page.close();
  });

  const bad = Object.entries(results).filter(([, v]) => (typeof v === "number" ? v !== 0 : v === false));
  console.log(JSON.stringify(results));
  process.exitCode = bad.length ? 1 : 0;
} finally {
  await runCleanups();
  await server.stop();
}
