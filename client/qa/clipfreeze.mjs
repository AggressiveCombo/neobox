// Menu clip hold check (RUBRIC D08 motion control): reduced motion (the OS preference or Settings > Motion) holds the
// menu clip on one still frame.
//
// Cases (per engine, desktop 1280x800, home menu):
//   clip.holdsReduced  the clip area (largest canvas behind the UI) is screenshot while playing and after reduced motion
//                      is emulated. Playing: consecutive frames differ (control: the clip really moves). Reduced: the frame
//                      stays identical for 2 s and is not blank (a blank frame would mean the hold cleared the picture).
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
        "clip.holdsReduced",
        async (s) => {
          const h = await s.open("clipfreeze", { name: "clipqa" });
          await h.page.goto(base);
          await menuName(h.page).waitFor({ timeout: 20000 });
          await h.page.locator(".menu-square.is-live").waitFor({ state: "attached", timeout: 20000 });
          await h.page.waitForTimeout(1500);
          const box = await clipBox(h.page);
          if (!box) throw new Error("no clip canvas on the home menu");

          const playingA = await snap(h, box, path.join(out, `${engine}-playing-a.png`));
          await h.page.waitForTimeout(1000);
          const playingB = await snap(h, box, path.join(out, `${engine}-playing-b.png`));

          await h.page.emulateMedia({ reducedMotion: "reduce" });
          await h.page.waitForTimeout(300);
          const heldA = await snap(h, box, path.join(out, `${engine}-held-a.png`));
          await h.page.waitForTimeout(1000);
          const heldB = await snap(h, box, path.join(out, `${engine}-held-b.png`));
          await h.page.waitForTimeout(1000);
          const heldC = await snap(h, box, path.join(out, `${engine}-held-c.png`));

          const held = heldA.hash === heldB.hash && heldB.hash === heldC.hash;
          const moving = playingA.hash !== playingB.hash;
          const notBlank = heldA.bytes > 1000;
          const pass = moving && held && notBlank;
          return {
            pass,
            detail: !moving ? "clip did not move while playing" : !held ? "clip changed under reduced motion" : !notBlank ? "held frame is blank" : undefined,
            metrics: { box, moving, held, notBlank, playingBytes: playingA.bytes, heldBytes: heldA.bytes },
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
