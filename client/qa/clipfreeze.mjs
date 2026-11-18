// Menu clip pause check (RUBRIC D08 motion control): the Pause control must freeze the visible clip.
//
// Cases (per engine, desktop 1280x800, home menu):
//   clip.pauseFreezes  the clip area (largest canvas behind the UI) is screenshot while playing and while paused.
//                      Playing: consecutive frames differ (control: the clip really moves). Paused: the frame stays
//                      identical for 2 s and is not blank (a blank frame would mean pause cleared the picture).
//
// Usage: cd client && QA_OUT=<dir> node qa/clipfreeze.mjs   (QA_ENGINES=chromium narrows the engines)

import { createHash } from "node:crypto";
import { writeFileSync } from "node:fs";
import path from "node:path";
import { Results, launchEngine, menuName, outDir, runCleanups, selectedEngines, startServer } from "./lib-qa.mjs";

/** Screenshot of the clip area: its SHA-1 and byte size (a blank frame compresses to a few hundred bytes). */
async function snap(h, box, file) {
  const buf = await h.page.screenshot({ clip: box });
  writeFileSync(file, buf);
  return { hash: createHash("sha1").update(buf).digest("hex"), bytes: buf.length };
}

/** Bounding box of the largest canvas on the page (the GL clip is drawn behind the UI). */
async function clipBox(page) {
  return page.evaluate(() => {
    let best = null;
    for (const c of document.querySelectorAll("canvas")) {
      const r = c.getBoundingClientRect();
      if (r.width > 0 && r.height > 0 && (!best || r.width * r.height > best.width * best.height)) {
        best = { x: r.x, y: r.y, width: r.width, height: r.height };
      }
    }
    return best;
  });
}

async function main() {
  const out = outDir();
  for (const engine of selectedEngines()) {
    const results = new Results("clipfreeze", engine);
    const server = await startServer();
    const base = server.base;
    const browser = await launchEngine(engine);
    try {
      await results.case(
        "clip.pauseFreezes",
        async (s) => {
          const h = await s.open("clipfreeze", { name: "clipqa" });
          await h.page.goto(base);
          await menuName(h.page).waitFor({ timeout: 20000 });
          await h.page.locator(".menu-clip-bar").waitFor({ state: "visible", timeout: 20000 });
          await h.page.waitForTimeout(1500);
          const box = await clipBox(h.page);
          if (!box) throw new Error("no clip canvas on the home menu");

          const playingA = await snap(h, box, path.join(out, `${engine}-playing-a.png`));
          await h.page.waitForTimeout(1000);
          const playingB = await snap(h, box, path.join(out, `${engine}-playing-b.png`));

          await h.page.locator(".menu-clip-pause").click();
          await h.page.waitForTimeout(300);
          const label = (await h.page.locator(".menu-clip-pause").textContent())?.trim();
          const pausedA = await snap(h, box, path.join(out, `${engine}-paused-a.png`));
          await h.page.waitForTimeout(1000);
          const pausedB = await snap(h, box, path.join(out, `${engine}-paused-b.png`));
          await h.page.waitForTimeout(1000);
          const pausedC = await snap(h, box, path.join(out, `${engine}-paused-c.png`));

          const frozen = pausedA.hash === pausedB.hash && pausedB.hash === pausedC.hash;
          const moving = playingA.hash !== playingB.hash;
          const pass = moving && frozen;
          return {
            pass,
            detail: !moving ? "clip did not move while playing" : !frozen ? "clip changed while paused" : undefined,
            metrics: { label, box, moving, frozen, playingBytes: playingA.bytes, pausedBytes: pausedA.bytes },
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
