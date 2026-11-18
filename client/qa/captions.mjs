// Sound-caption instrument (RUBRIC D08: a visible text cue for each audio cue).
//
// Cases (per engine, desktop 1280x800, inside a practice match):
//   caption.everyKindMuted   captions on, mute switch on: every engine sound kind (1-20 except kind 5, which the
//                            simulation never emits) and the win/lose jingles shows its caption when played through
//                            the game's own Sfx.play / Sfx.ui path. Captions do not depend on audio output.
//   caption.everyEmittedKind captions on, mute off: every sound kind the match actually emits reaches the caption
//                            path (recorded by the __qaSounds hook in audio.ts).
//
// Usage: cd client && QA_OUT=<dir> node qa/captions.mjs   (QA_ENGINES=chromium narrows the engines)

import { Results, launchEngine, runCleanups, selectedEngines, startPractice, startServer } from "./lib-qa.mjs";

/** Engine sound kinds that can be played. Kind 5 (push, nothing hit) is never emitted, so it has no caption to check. */
const KINDS = Array.from({ length: 20 }, (_, i) => i + 1).filter((k) => k !== 5);
const PREFS_KEY = "neobox.prefs";

/** Opens a practice match in a scenario handle. Prefs are written before the app script runs. */
async function openMatch(s, base, prefs) {
  const h = await s.open("captions", { name: "capqa" });
  await h.context.addInitScript(
    ({ key, value }) => localStorage.setItem(key, JSON.stringify(value)),
    { key: PREFS_KEY, value: prefs },
  );
  await startPractice(h, base, null, { pixels: false });
  return h;
}

async function main() {
  for (const engine of selectedEngines()) {
    const results = new Results("captions", engine);
    const server = await startServer();
    const base = server.base;
    const browser = await launchEngine(engine);
    try {
      await results.case(
        "caption.everyKindMuted",
        async (s) => {
          const h = await openMatch(s, base, { captions: true, muted: true });
          const shown = await h.page.evaluate((kinds) => {
            const line = () => {
              const c = document.querySelector(".sound-captions");
              return c && !c.hidden ? c.textContent : "";
            };
            const out = {};
            for (const k of kinds) {
              __qaSfx.play(k, 1);
              out[k] = line();
            }
            __qaSfx.ui("win");
            out.win = line();
            __qaSfx.ui("lose");
            out.lose = line();
            return out;
          }, KINDS);
          const missing = Object.keys(shown).filter((k) => !shown[k]);
          return {
            pass: missing.length === 0,
            detail: missing.length ? `no caption for kinds ${missing.join(",")}` : undefined,
            metrics: { checked: Object.keys(shown).length, missing },
          };
        },
        { browser, base },
      );

      await results.case(
        "caption.everyEmittedKind",
        async (s) => {
          const h = await openMatch(s, base, { captions: true, muted: false });
          await h.page.evaluate(() => {
            __qaSounds.emitted.clear();
            __qaSounds.captioned.clear();
          });
          // Drive the player through the actions that emit sounds: jump, push, bat, rocket (charge, then fire), grab, walk.
          const keys = ["Space", "KeyX", "KeyC", "KeyZ", "KeyV", "ArrowRight", "ArrowLeft"];
          for (let i = 0; i < 40; i++) {
            const key = keys[i % keys.length];
            await h.page.keyboard.down(key);
            await h.page.waitForTimeout(i % 7 === 3 ? 700 : 120);
            await h.page.keyboard.up(key);
            await h.page.waitForTimeout(150);
          }
          const { emitted, captioned } = await h.page.evaluate(() => ({
            emitted: [...__qaSounds.emitted].sort((a, b) => a - b),
            captioned: [...__qaSounds.captioned].sort((a, b) => a - b),
          }));
          const uncaptioned = emitted.filter((k) => !captioned.includes(k));
          return {
            pass: emitted.length > 0 && uncaptioned.length === 0,
            detail: emitted.length === 0 ? "no sound emitted in the match" : uncaptioned.length ? `uncaptioned kinds ${uncaptioned.join(",")}` : undefined,
            metrics: { emitted, captioned, uncaptioned },
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
