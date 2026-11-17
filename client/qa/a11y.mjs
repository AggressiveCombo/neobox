// Accessibility instruments (RUBRIC D06/D08): fonts.dyslexic.applied (Settings > Accessibility > Readable font),
// reducedMotion.pixelDiff (OS prefers-reduced-motion and in-app Motion = reduce; both must be 0 changed pixels
// once the page has settled), flash luminance and auto-moving content (informational), keyboard paste on sign-in.
// Records go to <QA_OUT>/a11y-<engine>.json (Results format). Usage: bun qa/a11y.mjs (QA_ENGINES to choose).

import { PNG } from "pngjs";
import { QaScenario } from "./capture.mjs";
import { differingPixels } from "./image.mjs";
import { stateById } from "./states.mjs";
import { rowById } from "./presets.mjs";
import { Results, launchEngine, menuName, runCleanups, selectedEngines, startServer } from "./lib-qa.mjs";

const W = 1280, H = 800;
const PREFS_KEY = "neobox.prefs";
const SETTLE_MS = 1500; // the intro transition after a reload; measured frames start after it
const PASTE_TEXT = "pasteprobe-123";

// Typography of up to 40 visible text elements: family, font size, line height (px), letter spacing (px).
const TYPO = () => {
  const vis = (el) => {
    const r = el.getBoundingClientRect();
    const cs = getComputedStyle(el);
    return r.width > 0 && r.height > 0 && cs.visibility !== "hidden" && cs.display !== "none";
  };
  const els = [...document.querySelectorAll("h1,h2,h3,p,label,button,a,li,summary,span,td,th")]
    .filter((e) => e.childElementCount === 0 && e.textContent.trim() && vis(e))
    .slice(0, 40);
  const probeLh = (cs) => {
    const d = document.createElement("div");
    Object.assign(d.style, { position: "absolute", visibility: "hidden", whiteSpace: "nowrap", fontFamily: cs.fontFamily, fontSize: cs.fontSize, fontWeight: cs.fontWeight, letterSpacing: cs.letterSpacing, wordSpacing: cs.wordSpacing, lineHeight: "normal" });
    d.textContent = "Ag";
    document.body.appendChild(d);
    const h = d.getBoundingClientRect().height;
    d.remove();
    return h;
  };
  const sample = els.map((el) => {
    const cs = getComputedStyle(el);
    const fs = parseFloat(cs.fontSize);
    const lh = cs.lineHeight === "normal" ? probeLh(cs) : parseFloat(cs.lineHeight);
    const ls = cs.letterSpacing === "normal" ? 0 : parseFloat(cs.letterSpacing);
    return { tag: el.tagName, text: el.textContent.trim().slice(0, 30), ff: cs.fontFamily, fs, lh, ls };
  });
  return { bodyFF: getComputedStyle(document.body).fontFamily, sample };
};

const median = (xs) => {
  const s = xs.filter(Number.isFinite).sort((a, b) => a - b);
  return s.length ? s[Math.floor(s.length / 2)] : NaN;
};
function compareTypo(before, after) {
  const n = Math.min(before.sample.length, after.sample.length);
  const lhEm = [], lsEm = [];
  for (let i = 0; i < n; i++) {
    const a = before.sample[i], b = after.sample[i];
    if (a.tag !== b.tag) continue;
    lhEm.push((b.lh - a.lh) / a.fs);
    lsEm.push((b.ls - a.ls) / a.fs);
  }
  return {
    n,
    familyChanged: before.bodyFF !== after.bodyFF,
    bodyFF: [before.bodyFF, after.bodyFF],
    medianLineHeightDeltaEm: +median(lhEm).toFixed(3),
    medianLetterSpacingDeltaEm: +median(lsEm).toFixed(3),
  };
}

// Consecutive and first-frame pixel changes over ten screenshots of the settled page (fraction of the viewport).
async function motionDiff(page, mode) {
  await page.evaluate(() => document.activeElement?.blur());
  const bufs = [];
  const t0 = Date.now();
  for (let i = 0; i < 10; i++) bufs.push(await page.screenshot({ caret: "hide", animations: "allow" }));
  const spanMs = Date.now() - t0;
  const frac = (a, b) => differingPixels(a, b) / (W * H);
  const vsFirst = bufs.slice(1).map((b) => frac(bufs[0], b));
  const consecutive = bufs.slice(1).map((b, i) => frac(bufs[i], b));
  return { mode, maxFractionVsFirst: +Math.max(...vsFirst).toFixed(5), maxConsecutive: +Math.max(...consecutive).toFixed(5), spanMs };
}

function meanLuma(buf) {
  const p = PNG.sync.read(buf);
  let sum = 0;
  const n = p.width * p.height;
  for (let i = 0; i < p.data.length; i += 4 * 4) sum += 0.2126 * p.data[i] + 0.7152 * p.data[i + 1] + 0.0722 * p.data[i + 2];
  return sum / (n / 4) / 255;
}

async function frames(page, n) {
  const bufs = [];
  for (let i = 0; i < n; i++) bufs.push(await page.screenshot({ caret: "hide", animations: "allow" }));
  return bufs;
}


async function runEngine(engine, base) {
  const results = new Results("a11y", engine);
  const rec = (id, verdict, metrics = {}, detail) => {
    results.cases.push({ id, verdict, metrics, detail, seconds: 0 });
    console.log(`${verdict.toUpperCase()} a11y/${engine}/${id} ${JSON.stringify(metrics).slice(0, 300)}`);
  };
  const browser = await launchEngine(engine);
  const cap = { engine, theme: "dark", row: rowById("T1-M"), axis: "none", renderer: null };
  const scen = () => new QaScenario("a11y", { base, browser }, cap);
  try {
    // ---- Settings: Accessibility > Readable font
    const S1 = scen();
    const sp = (await stateById("settings").prepare(S1)).page;
    await sp.locator(".settings-nav-item", { hasText: "Accessibility" }).first().click();
    await sp.waitForTimeout(300);
    const setBefore = await sp.evaluate(TYPO);
    const sw = sp.getByRole("switch", { name: "Readable font" });
    const swCount = await sw.count();
    const swBefore = swCount ? await sw.isChecked() : null; // kit.ts switch is a checkbox[role=switch]: state is `checked`, not aria-checked
    if (swCount) await sw.click();
    await sp.waitForTimeout(400);
    const setAfter = await sp.evaluate(TYPO);
    const swAfter = swCount ? await sw.isChecked() : null;
    const prefsStore = await sp.evaluate(() => Object.fromEntries(Object.keys(localStorage).map((k) => [k, localStorage.getItem(k)])));
    const prefsEntry = Object.entries(prefsStore).find(([, v]) => /"readableFont":\s*true/.test(v));
    const settingsTypo = compareTypo(setBefore, setAfter);
    await sp.screenshot({ path: `${results.evidenceDir}/settings-readable-on.png` });
    const dyslexicApplied = swCount > 0 && swAfter === true && !!prefsEntry && (settingsTypo.familyChanged || settingsTypo.medianLetterSpacingDeltaEm > 0 || settingsTypo.medianLineHeightDeltaEm > 0);
    rec("fonts.dyslexic.applied.settings", dyslexicApplied ? "pass" : "fail", { switchFound: swCount, before: swBefore, after: swAfter, prefsKey: prefsEntry?.[0] ?? null, typo: settingsTypo });

    await sp.emulateMedia({ reducedMotion: "reduce" });
    await sp.waitForTimeout(SETTLE_MS);
    const sRed = await motionDiff(sp, "os-reduce");
    await sp.emulateMedia({ reducedMotion: "no-preference" });
    const sNo = await motionDiff(sp, "no-preference(control)");
    rec("reducedMotion.pixelDiff.settings.osReduce", sRed.maxFractionVsFirst === 0 ? "pass" : "fail", { value: sRed.maxFractionVsFirst, os: sRed, control: sNo });

    // ---- Menu: readable font, OS reduce, in-app Motion = reduce, flash, auto-moving content, paste on sign-in
    const S2 = scen();
    const mp = (await stateById("menu-anon").prepare(S2)).page;
    const menuBefore = await mp.evaluate(TYPO);
    if (prefsEntry) {
      await mp.evaluate(([k, v]) => localStorage.setItem(k, v), [prefsEntry[0], prefsEntry[1]]);
      await mp.reload();
      await menuName(mp).waitFor();
    }
    const menuAfter = await mp.evaluate(TYPO);
    await mp.screenshot({ path: `${results.evidenceDir}/menu-readable-on.png` });
    const menuTypo = compareTypo(menuBefore, menuAfter);
    rec("fonts.dyslexic.applied.menu", prefsEntry && (menuTypo.familyChanged || menuTypo.medianLetterSpacingDeltaEm > 0 || menuTypo.medianLineHeightDeltaEm > 0) ? "pass" : "fail", { typo: menuTypo });

    await mp.emulateMedia({ reducedMotion: "reduce" });
    await mp.waitForTimeout(SETTLE_MS);
    const mRed = await motionDiff(mp, "os-reduce");
    await mp.emulateMedia({ reducedMotion: "no-preference" });
    const mNo = await motionDiff(mp, "no-preference(control)");
    rec("reducedMotion.pixelDiff.menu.osReduce", mRed.maxFractionVsFirst === 0 ? "pass" : "fail", { value: mRed.maxFractionVsFirst, os: mRed, control: mNo });

    // In-app Motion = reduce with the OS at no-preference (the app's own setting must hold the frame).
    const raw = await mp.evaluate((k) => localStorage.getItem(k), PREFS_KEY);
    const cur = raw ? JSON.parse(raw) : {};
    await mp.evaluate(([k, v]) => localStorage.setItem(k, v), [PREFS_KEY, JSON.stringify({ ...cur, motion: "reduce" })]);
    await mp.reload();
    await menuName(mp).waitFor();
    await mp.emulateMedia({ reducedMotion: "no-preference" });
    await mp.waitForTimeout(SETTLE_MS);
    const mApp = await motionDiff(mp, "app-Motion=reduce, OS no-preference");
    rec("reducedMotion.pixelDiff.menu.appReduce", mApp.maxFractionVsFirst === 0 ? "pass" : "fail", { value: mApp.maxFractionVsFirst, ...mApp });
    await mp.evaluate(([k, v]) => localStorage.setItem(k, v), [PREFS_KEY, raw ?? JSON.stringify({})]);

    // Flash series (informational): mean luminance of the viewport over ~3 s at about 10 fps.
    await mp.reload();
    await menuName(mp).waitFor();
    await mp.emulateMedia({ reducedMotion: "no-preference" });
    const lum = (await frames(mp, 30)).map(meanLuma);
    let maxSwing = 0, reversals = 0, prevDir = 0;
    for (let i = 1; i < lum.length; i++) {
      const d = lum[i] - lum[i - 1];
      const rel = Math.abs(d) / Math.max(Math.min(lum[i], lum[i - 1]), 1e-3);
      maxSwing = Math.max(maxSwing, rel);
      const dir = Math.sign(d);
      if (dir && prevDir && dir !== prevDir && rel >= 0.1) reversals++;
      if (dir) prevDir = dir;
    }
    rec("menu.flash.luma", "info", { maxRelativeSwing: +maxSwing.toFixed(4), opposingSwingsAtLeast10pct: reversals, note: "~10 fps sampling cannot resolve flashes above 5 Hz" });

    // Sign-in paste: keyboard Ctrl+V into the password field. Verifiable only when the engine's clipboard round-trips.
    if (browser.clipboard) await mp.context().grantPermissions(["clipboard-read", "clipboard-write"], { origin: base }).catch(() => {});
    await mp.getByRole("button", { name: "Sign in", exact: true }).click();
    const pw = mp.locator("input[type=password]").first();
    await pw.waitFor({ timeout: 8000 }).catch(() => {});
    const probe = await mp.evaluate(async (text) => {
      try { await navigator.clipboard.writeText(text); return await navigator.clipboard.readText(); } catch (e) { return `ERR:${e}`; }
    }, PASTE_TEXT);
    const verifiable = probe === PASTE_TEXT;
    let pasted = null, pasteErr = null;
    if (verifiable) {
      try {
        await pw.focus();
        await mp.keyboard.press("Control+V");
        await mp.waitForTimeout(200);
        pasted = await pw.inputValue();
      } catch (e) {
        pasteErr = String(e).slice(0, 200);
      }
    }
    await mp.screenshot({ path: `${results.evidenceDir}/signin-paste.png` });
    rec("auth.paste", !verifiable ? "info" : pasted === PASTE_TEXT ? "pass" : "fail", { pastedValue: pasted, pasteErr, pasteVerifiable: verifiable, clipboardProbe: probe.slice(0, 120) }, verifiable ? undefined : "clipboard round-trip not available on this engine; paste not measured");
  } catch (err) {
    rec("script", "fail", { error: String(err).slice(0, 400) });
  } finally {
    results.save();
    await runCleanups();
  }
}

// One server per engine: runCleanups() after an engine also stops the server it started.
for (const engine of selectedEngines()) {
  const server = await startServer();
  try {
    await runEngine(engine, server.base);
  } finally {
    await runCleanups();
  }
}
