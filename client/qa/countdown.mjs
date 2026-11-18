// Start countdown announcement (RUBRIC D07 sr.statusMessages; D08 reduce-motion keeps the state change).
//
// Cases (per engine, desktop 1280x800, a two-player room match):
//   hud.countdownLive  the countdown is announced through a polite live region (role=status) each second
//                      ("Match starting in N seconds", down to 1 second) and then "Go". The host page polls every
//                      role=status node from before Start; the log of distinct texts with timestamps is the evidence.
//
// Usage: cd client && QA_OUT=<dir> node qa/countdown.mjs   (QA_ENGINES=chromium narrows the engines)

import path from "node:path";
import { writeFileSync } from "node:fs";
import {
  Results,
  createRoom,
  joinByInvite,
  launchEngine,
  outDir,
  roomTitle,
  runCleanups,
  selectedEngines,
  startMatch,
  startServer,
  uniqueName,
} from "./lib-qa.mjs";

const COUNTDOWN = /^Match starting in \d+ seconds?$|^Go$/;

/** Records every distinct countdown text in polite live regions, with time since first sight. */
const RECORDER = `(() => {
  const log = (window.__countdownLog = []);
  const t0 = performance.now();
  const seen = new Set();
  setInterval(() => {
    for (const el of document.querySelectorAll('[role="status"], [aria-live="polite"]')) {
      const text = (el.textContent || "").trim();
      if (!/^Match starting in \\d+ seconds?$|^Go$/.test(text)) continue;
      const key = text + "@" + el.getAttribute("aria-live") + "@" + (el.getAttribute("role") || "");
      if (seen.has(key)) continue;
      seen.add(key);
      log.push({ at: Math.round(performance.now() - t0), text, role: el.getAttribute("role"), live: el.getAttribute("aria-live") });
    }
  }, 50);
  return true;
})();`;

async function main() {
  const out = outDir();
  for (const engine of selectedEngines()) {
    const results = new Results("countdown", engine);
    const server = await startServer();
    const base = server.base;
    const browser = await launchEngine(engine);
    try {
      await results.case(
        "hud.countdownLive",
        async (s) => {
          const roomName = uniqueName("room");
          const host = await s.open("countdown", { name: uniqueName("host") });
          const code = await createRoom(host, base, roomName, { isPublic: false });
          const guest = await s.open("guest", { name: uniqueName("guest") });
          await joinByInvite(guest, base, code, roomName);
          await roomTitle(guest.page, roomName).waitFor();
          await host.page.locator("li.room-player").nth(1).waitFor();
          await host.page.evaluate(RECORDER);
          await startMatch(host, [guest]);
          // The countdown runs in the HUD before play; wait for its Go line.
          await host.page.waitForFunction(() => (window.__countdownLog ?? []).some((e) => e.text === "Go"), null, { timeout: 20000 }).catch(() => {});
          const log = await host.page.evaluate(() => window.__countdownLog ?? []);
          writeFileSync(path.join(out, `${engine}-countdown-live.json`), JSON.stringify(log, null, 1));
          const texts = log.map((e) => e.text);
          const needed = ["Match starting in 3 seconds", "Match starting in 2 seconds", "Match starting in 1 second", "Go"];
          const missing = needed.filter((t) => !texts.includes(t));
          const bad = log.filter((e) => e.role !== "status" && e.live !== "polite");
          return {
            pass: missing.length === 0 && bad.length === 0 && log.every((e) => COUNTDOWN.test(e.text)),
            detail: missing.length ? `missing announcements: ${missing.join("; ")}` : bad.length ? "countdown text outside a polite live region" : undefined,
            metrics: { announced: log.length, texts, missing },
          };
        },
        { browser, base },
      );
    } finally {
      results.save();
      await browser.close().catch(() => {});
      await runCleanups();
    }
  }
}

await main();
