// DOM churn probe: counts focusable controls that are replaced (removed and not re-attached in the same
// tick) while a screen sits idle, and checks that keyboard focus survives broadcasts. Screens: the room
// (broadcasts about once a second while not in a match), the room browser and the admin page.
//
// Usage: `bun qa/domchurn.mjs [--engine firefox] [--idle 10]` with NEOBOX_DIST (or --dist) set.
// Exit status: 0 when every idle window replaced 0 focusable controls and focus survived, 1 otherwise.

import { button, createRoom, DESKTOP, launchEngine, menuName, roomTitle, runCleanups, sleep, startServer, uniqueName } from "./lib-qa.mjs";
import { ADMIN_PASSWORD } from "../e2e/lib.mjs";

const arg = (flag, fallback) => {
  const i = process.argv.indexOf(flag);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
};
const ENGINE = arg("--engine", "firefox");
const IDLE_MS = Number(arg("--idle", "10")) * 1000;
const SETTLE_MS = 2000; // screen transitions (dialog close, menu teardown) finish before the idle window counts
const FOCUS_MS = 5000;

const FOCUSABLE = "button,input,select,textarea,a[href],[tabindex]:not([tabindex='-1'])";

/** Installs the observer that records focusable nodes removed and not re-attached (a true replacement). */
async function startWatch(page) {
  await page.evaluate((focusable) => {
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
    new MutationObserver((records) => {
      for (const rec of records) {
        for (const node of rec.removedNodes) {
          if (!(node instanceof Element)) continue;
          if (node.matches(focusable)) pending.push(node);
          for (const el of node.querySelectorAll(focusable)) pending.push(el);
        }
        window.__churn.observed++;
      }
      queueMicrotask(flush);
    }).observe(document.body, { childList: true, subtree: true });
  }, FOCUSABLE);
}

/** Settles the screen, then runs an idle window and returns the number of replaced focusable controls. */
async function idleWindow(page, label, ms = IDLE_MS) {
  await sleep(SETTLE_MS);
  await startWatch(page);
  await sleep(ms);
  const { replaced, observed } = await page.evaluate(() => window.__churn);
  console.log(`[${label}] idle ${ms / 1000}s: replaced focusable controls ${replaced.length}, mutation records ${observed}`);
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

const results = {};
const server = await startServer();
const browser = await launchEngine(ENGINE);
try {
  // Room: a host alone in a public room. The room re-renders on every broadcast.
  const host = await browser.newPage({ viewport: DESKTOP.viewport });
  const roomName = uniqueName("dc");
  const code = await createRoom({ page: host }, server.base, roomName, { isPublic: true });
  await roomTitle(host, roomName).waitFor();
  results.room = await idleWindow(host, "room");
  results.roomInviteFocus = await focusSurvives(host, "room Invite", host.locator("[data-focus-key=invite]"));

  // Browse: the room list with the room above. Focus its row and check it survives.
  const guest = await browser.newPage({ viewport: DESKTOP.viewport });
  await guest.goto(server.base);
  await menuName(guest).waitFor();
  await button(guest, "Browse rooms").click();
  const row = guest.locator("button.room-row").filter({ hasText: roomName });
  await row.waitFor();
  results.browse = await idleWindow(guest, "browse");
  results.browseRowFocus = await focusSurvives(guest, "browse room row", row);

  // Admin: log in, select the room, then sit on the tables that refresh every second.
  const admin = await browser.newPage({ viewport: DESKTOP.viewport });
  await admin.goto(`${server.base}/admin`);
  await admin.locator("#pw").fill(ADMIN_PASSWORD);
  await button(admin, "Log in").click();
  await admin.getByRole("heading", { name: "Map approvals" }).waitFor();
  await admin.locator("#rooms tbody tr").filter({ hasText: code }).click();
  await admin.locator("#players tbody button").first().waitFor();
  results.admin = await idleWindow(admin, "admin");
  results.adminPlayerFocus = await focusSurvives(admin, "admin player Host", admin.locator("#players tbody button").first());

  const bad = Object.entries(results).filter(([, v]) => (typeof v === "number" ? v !== 0 : v === false));
  console.log(JSON.stringify(results));
  process.exitCode = bad.length ? 1 : 0;
} finally {
  await runCleanups();
  await server.stop();
}
