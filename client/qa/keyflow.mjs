// Keyboard-only flows (RUBRIC D07/D08): menu tab order, browse -> create room -> lobby -> match -> leave,
// news modal trap and Escape restore, header tool reachable. Only Tab, Shift+Tab, Enter, Escape and arrows
// are sent; no pointer input. Records go to <QA_OUT>/keyflow-<engine>.json (Results format).
// Usage: bun qa/keyflow.mjs   (QA_ENGINES=chromium,firefox,webkit to choose engines; NEOBOX_DIST for the build)

import { Results, launchEngine, onCleanup, runCleanups, selectedEngines, startServer } from "./lib-qa.mjs";

const TRAP_TABS = 25;
const NEWS_TABS = 20;
const MENU_MAX_TABS = 200;

// Accessible-name approximation for the focused element, computed in page.
const FOCUS_INFO = () => {
  const el = document.activeElement;
  if (!el || el === document.body) return { tag: "BODY", name: "", role: "", inDialog: false, ring: "none" };
  const labelledby = el.getAttribute("aria-labelledby");
  const lb = labelledby ? labelledby.split(/\s+/).map((id) => document.getElementById(id)?.textContent ?? "").join(" ") : "";
  const name = (el.getAttribute("aria-label") || lb || el.getAttribute("title") || el.textContent || el.getAttribute("placeholder") || el.value || "").replace(/\s+/g, " ").trim();
  const r = el.getBoundingClientRect();
  const dlg = el.closest("[role=dialog],[role=alertdialog],dialog");
  return {
    tag: el.tagName,
    role: el.getAttribute("role") || el.tagName.toLowerCase(),
    name: name.slice(0, 80),
    inDialog: !!dlg,
    dialogName: dlg ? (dlg.getAttribute("aria-label") || dlg.querySelector("h1,h2,h3")?.textContent || "").trim().slice(0, 60) : "",
    // Computed-style indicator only (outline or box-shadow). Border-based indicators are checked by focus.mjs.
    ring: (() => { const cs = getComputedStyle(el); return (cs.outlineStyle !== "none" && parseFloat(cs.outlineWidth) > 0) || cs.boxShadow !== "none" ? "indicator" : "none"; })(),
    box: [Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height)],
  };
};

const focused = (page) => page.evaluate(FOCUS_INFO);

// Tab n times inside a dialog. A stop outside the dialog (including BODY) counts as a leak; it must recover on the next Tab.
async function trapCheck(page, n) {
  let leftDialog = 0, unrecovered = 0;
  const samples = [];
  for (let i = 0; i < n; i++) {
    await page.keyboard.press("Tab");
    const f = await focused(page);
    if (!f.inDialog) {
      leftDialog++;
      if (samples.length < 6) samples.push(`${f.tag}:${f.name}`);
      await page.keyboard.press("Tab");
      const g = await focused(page);
      if (!g.inDialog) unrecovered++;
    }
  }
  return { leftDialog, unrecovered, samples };
}

// Press Tab (or Shift+Tab) until the focused element's name matches. Returns the trail.
async function tabTo(page, re, { max = 80, shift = false, scope = null } = {}) {
  const trail = [];
  for (let i = 0; i < max; i++) {
    await page.keyboard.press(shift ? "Shift+Tab" : "Tab");
    const f = await focused(page);
    trail.push(`${f.role}:${f.name}`);
    if (re.test(f.name) && (!scope || scope(f))) return { ok: true, f, trail };
  }
  return { ok: false, f: await focused(page), trail };
}

// Rolls the home drum to `label` from the keyboard: Tab to the Destinations listbox, then ArrowDown until the option is centred.
async function drumByKeys(page, label) {
  const toDrum = await tabTo(page, /^Destinations$/);
  const opt = page.getByRole("option", { name: label, exact: true });
  for (let k = 0; k < 24 && (await opt.getAttribute("aria-selected")) !== "true"; k += 1) await page.keyboard.press("ArrowDown");
  return { ok: toDrum.ok && (await opt.getAttribute("aria-selected")) === "true", trail: toDrum.trail };
}

/**
 * Tab order of the menu over two full cycles. A cycle ends when focus leaves the page (BODY stop); the second cycle
 * must repeat the first one exactly. Returns the first cycle's stops and whether the second matched it.
 */
async function menuCycles(page) {
  // Walk from the page top until focus reaches BODY (focus left the page).
  const walk = async () => {
    const stops = [];
    for (let i = 0; i < MENU_MAX_TABS; i++) {
      await page.keyboard.press("Tab");
      const f = await focused(page);
      // Firefox can still report the previous element on the Tab that leaves the page; a repeat is a stale read, not a stop.
      const last = stops.at(-1);
      if (last && last.tag === f.tag && last.role === f.role && last.name === f.name) continue;
      stops.push(f);
      if (f.tag === "BODY") return { stops: stops.slice(0, -1), complete: true };
    }
    return { stops, complete: false };
  };
  // Each cycle starts on a fresh load: a blur alone leaves Firefox's stale focus point, which skips the header tools.
  const first = await walk();
  if (!first.complete) return { cycle: first.stops, second: [], repeats: false, complete: false };
  await page.reload();
  await page.getByPlaceholder("name", { exact: true }).waitFor();
  await page.evaluate(() => document.activeElement?.blur());
  const second = await walk();
  const repeats = second.complete && first.stops.length === second.stops.length &&
    first.stops.every((f, i) => f.name === second.stops[i].name && f.role === second.stops[i].role);
  return { cycle: first.stops, second: second.stops, repeats, complete: second.complete };
}

async function runEngine(engine, base) {
  const results = new Results("keyflow", engine);
  const rec = (id, pass, detail = {}) => {
    const { seconds, ...metrics } = detail;
    results.cases.push({ id, verdict: pass ? "pass" : "fail", metrics, seconds: seconds ?? 0 });
    console.log(`${pass ? "PASS" : "FAIL"} keyflow/${engine}/${id} ${JSON.stringify(metrics).slice(0, 400)}`);
  };

  const browser = await launchEngine(engine);
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 }, colorScheme: "dark" });
  onCleanup(() => ctx.close().catch(() => {}));
  const page = await ctx.newPage();
  const pageErrors = [];
  page.on("pageerror", (e) => pageErrors.push(String(e)));
  await ctx.addInitScript(() => localStorage.setItem("neobox.name", "kbqa"));

  try {
    // ---- K1: menu -> browse -> new room -> lobby -> start -> HUD -> leave, keyboard only
    await page.goto(base);
    await page.getByPlaceholder("name", { exact: true }).waitFor();
    await page.evaluate(() => document.activeElement?.blur());
    const menu = await menuCycles(page);
    await page.screenshot({ path: `${results.evidenceDir}/k1-menu.png` });
    rec("menu.tabStops", menu.complete && menu.cycle.length >= 5 && menu.cycle.every((f) => f.tag !== "BODY") && menu.repeats, {
      stops: menu.cycle.length,
      repeats: menu.repeats,
      second: menu.second.map((f) => `${f.role}:${f.name}`).slice(0, 30),
      trail: menu.cycle.map((f) => `${f.role}:${f.name}`).slice(0, 30),
    });
    const noRing = menu.cycle.filter((f) => f.ring === "none");
    rec("menu.focusComputedIndicator", menu.complete && noRing.length === 0, { noComputedRing: noRing.map((f) => f.name) });

    await page.evaluate(() => { document.activeElement?.blur(); document.body.focus(); });
    const toBrowse = await drumByKeys(page, "Browse rooms");
    rec("menu.reachBrowse", toBrowse.ok, { trail: toBrowse.trail.slice(-6) });
    await page.keyboard.press("Enter");
    await page.getByRole("heading", { name: "Browse rooms", exact: true }).waitFor({ timeout: 8000 }).catch(() => {});
    const toNew = await tabTo(page, /^New room$/);
    rec("browse.reachNewRoom", toNew.ok, { trail: toNew.trail.slice(-6) });
    await page.keyboard.press("Enter");
    await page.getByRole("heading", { name: "Create a room", exact: true }).waitFor({ timeout: 8000 }).catch(() => {});
    const afterOpen = await focused(page);
    rec("createRoom.focusMovedIntoDialog", afterOpen.inDialog, { focus: afterOpen });
    const trap1 = await trapCheck(page, TRAP_TABS);
    rec("createRoom.trap", trap1.leftDialog === 0 && trap1.unrecovered === 0, trap1);
    await page.keyboard.press("Shift+Tab");
    const toName = await tabTo(page, /room name/i, { max: 30, shift: true, scope: (f) => f.tag === "INPUT" }).catch(() => ({ ok: false, trail: [] }));
    const nameFocus = await focused(page);
    if (!/room name/i.test(nameFocus.name) && nameFocus.tag !== "INPUT") {
      rec("createRoom.nameFieldReachable", false, { focus: nameFocus, trail: toName.trail?.slice(-8) });
    } else {
      await page.keyboard.type("KB qa room");
      rec("createRoom.nameFieldReachable", true, { focus: nameFocus });
    }
    const toCreate = await tabTo(page, /^Create room$/, { max: 20, scope: (f) => f.inDialog });
    rec("createRoom.reachCreate", toCreate.ok, { trail: toCreate.trail });
    if (toCreate.ok) await page.keyboard.press("Enter");
    const lobby = await page.locator("h1.room-title").filter({ hasText: "KB qa room" }).waitFor({ timeout: 8000 }).then(() => true, () => false);
    rec("lobby.entered", lobby);
    await page.screenshot({ path: `${results.evidenceDir}/k1-lobby.png` });
    const startTo = await tabTo(page, /^Start$/, { max: 80 });
    rec("lobby.reachStart", startTo.ok, { trail: startTo.trail.slice(-6) });
    if (startTo.ok) await page.keyboard.press("Enter");
    const hud = await page.locator(".hud-leave").waitFor({ state: "visible", timeout: 20000 }).then(() => true, () => false);
    rec("match.hudVisible", hud);
    await page.screenshot({ path: `${results.evidenceDir}/k1-match-hud.png` });
    await page.keyboard.down("ArrowLeft");
    await page.waitForTimeout(400);
    await page.keyboard.up("ArrowLeft");
    await page.keyboard.down("ArrowRight");
    await page.waitForTimeout(400);
    await page.keyboard.up("ArrowRight");
    const leaveTo = await tabTo(page, /leave/i, { max: 120 });
    rec("match.reachLeave", leaveTo.ok, { trail: leaveTo.trail.slice(-8) });
    if (leaveTo.ok) await page.keyboard.press("Enter");
    const back = await page.getByPlaceholder("name", { exact: true }).waitFor({ timeout: 10000 }).then(() => true, () => false);
    rec("leave.backToMenu", back || (await page.locator("h1.room-title").count()) === 0, { url: page.url() });

    // ---- K2: News modal focus trap and Escape restore
    await page.goto(base);
    await page.getByPlaceholder("name", { exact: true }).waitFor();
    const toNews = await drumByKeys(page, "News");
    rec("news.reach", toNews.ok, { trail: toNews.trail.slice(-4) });
    const newsTrigger = await focused(page);
    await page.keyboard.press("Enter");
    await page.waitForTimeout(400);
    const trap2 = await trapCheck(page, NEWS_TABS);
    rec("news.trap", trap2.leftDialog === 0 && trap2.unrecovered === 0, trap2);
    await page.keyboard.press("Escape");
    await page.waitForTimeout(400);
    const afterEsc = await focused(page);
    rec("news.escapeCloses", !afterEsc.inDialog, { focus: afterEsc });
    rec("news.focusRestored", afterEsc.name === newsTrigger.name, { expected: newsTrigger.name, actual: afterEsc.name });
    await page.screenshot({ path: `${results.evidenceDir}/k2-news-closed.png` });

    // ---- K3: a header tool is reachable by keyboard
    await page.goto(base);
    await page.getByPlaceholder("name", { exact: true }).waitFor();
    const toTool = await tabTo(page, /^(About|Settings|Profile|Account|Sign in)$/i, { max: 60 });
    rec("reachHeaderTool", toTool.ok, { trail: toTool.trail.slice(-6), focus: toTool.f });
    await page.screenshot({ path: `${results.evidenceDir}/k3-menu-keyboard.png` });

    rec("pageErrors", pageErrors.length === 0, { pageErrors: pageErrors.slice(0, 5) });
  } catch (err) {
    rec("script", false, { error: String(err).slice(0, 600) });
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
