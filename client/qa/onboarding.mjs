// Onboarding instrument (RUBRIC D15 proxy, anchor 9). Each case starts from a cold profile (a new
// browser context: empty localStorage, no name, no Training badge dismissed).
//
//   onboarding.ttfmS.proxy     seconds from navigation to the first movement that moves the local
//                              character in Training: keyboard (desktop, T1-M) or the touch stick
//                              (portrait phone, T3-T). Movement is read from the frame buffer
//                              (local player x, HOOK below).
//   onboarding.steps.proxy     calls to action taken before that movement: splash, menu, rotate gate
//                              (CTA clicks) and viewport rotations. Movement itself is not a step.
//   onboarding.phone           1 for the phone (touch) cases.
//
// CTA rule (chooseCta, run in the page): the topmost visible open dialog is the scope (else the page);
// among its visible enabled buttons the highest score wins: contains the visible "Start here" badge,
// then class primary, then largest area. Nothing is hardcoded per screen.
//
// Completion (anchor 9), Training's 7 lessons per profile:
//   K  keyboard only: Tab to Next, Enter per lesson (T1-K)
//   M  keyboard movement and mouse Next; Leave is used as the skip at lesson 3, Training is re-entered
//      and all 7 lessons completed (T1-M)
//   T  landscape phone (844x390): touch stick moves the character, tap Next; chips must follow the touch
//      profile (T4-T)
//   G  gamepad mock (PAD_INIT): d-pad moves the character; A is tried on Next (G1)
// Every lesson step checks Leave (skip) is visible and enabled, and saves a screenshot.
// Splash (phone): dialog "Welcome" shown once per device; Not now and Escape both close it; a reload after
// either shows none (splash-once).
//
// Usage:  cd client && QA_OUT=C:/Users/aggressivecombo/neobox-scratch/qa/round3-onboarding node qa/onboarding.mjs
//         (QA_ENGINES=chromium narrows the engines)

import path from "node:path";
import {
  Results,
  button,
  dismissPhoneSplash,
  launchEngine,
  menuName,
  rel,
  runCleanups,
  selectedEngines,
  shot,
  sleep,
  startServer,
  writeIndex,
} from "./lib-qa.mjs";
import { navTo } from "../e2e/lib.mjs";

const LESSONS = 7;
const LANDSCAPE = { width: 844, height: 390 };
const MOVE_MIN = 0.5; // world units of travel that count as movement (input.mjs MOVE_MIN)
const MOVE_WINDOW_MS = 4000;
const GATE_WAIT_MS = 3000;
const GATE_SETTLE_MS = 2000;
const RIGHT = "ArrowRight"; // default prefs (client/src/input.ts DEFAULT_KEYS)
const LEFT = "ArrowLeft";
const PAD_DPAD_RIGHT = 15;
const PAD_A = 0;

// Keyboard lesson chips per engine, so the touch run can tell whether its chips follow its profile.
const keyboardChips = new Map();

// Frame-buffer reader: local player x (input.mjs HOOK, reduced to the position).
const HOOK = () => {
  const acc = { x: null, found: 0 };
  window.__qa = acc;
  const parse = (ex) => {
    const len = ex.nb_frame_len();
    if (len < 64) return;
    const buf = ex.memory.buffer;
    const ptr = ex.nb_frame_ptr();
    const u = new Uint32Array(buf, ptr, len >>> 2);
    const f = new Float32Array(buf, ptr, len >>> 2);
    const localId = new Int32Array(buf, ptr, len >>> 2)[15];
    const pc = u[3];
    const po = u[4];
    for (let k = 0; k < pc; k++) {
      const b = po + k * 14;
      if (u[b] !== localId) continue;
      acc.x = f[b + 1];
      acc.found++;
      return;
    }
  };
  const wrap = (result) => {
    const ex = result.instance.exports;
    const api = { ...ex };
    const localFrame = ex.nb_local_frame;
    api.nb_local_frame = (dt, mask) => {
      const rc = localFrame(dt, mask);
      parse(ex);
      return rc;
    };
    const frame = ex.nb_frame;
    api.nb_frame = (nowMs, mask) => {
      const rc = frame(nowMs, mask);
      parse(ex);
      return rc;
    };
    return { module: result.module, instance: { exports: api } };
  };
  const origStreaming = WebAssembly.instantiateStreaming;
  WebAssembly.instantiateStreaming = async (...a) => wrap(await origStreaming.apply(WebAssembly, a));
  const origInstantiate = WebAssembly.instantiate;
  WebAssembly.instantiate = async (...a) => {
    const r = await origInstantiate.apply(WebAssembly, a);
    return r.instance ? wrap(r) : r;
  };
};

// Standard gamepad mock (input.mjs PAD_INIT): navigator.getGamepads returns one pad; the test sets buttons.
const PAD_INIT = () => {
  const pad = {
    id: "qa-pad (STANDARD GAMEPAD)",
    index: 0,
    connected: true,
    mapping: "standard",
    buttons: Array.from({ length: 17 }, () => ({ pressed: false, value: 0 })),
    axes: [0, 0, 0, 0],
  };
  window.__qaPad = pad;
  Object.defineProperty(navigator, "getGamepads", { value: () => [pad], configurable: true });
};

// The most prominent visible call to action in the topmost open dialog (else the page). Marks it with
// data-qa-cta and returns its name; the caller clicks the marked element.
const PICK = () => {
  const shown = (el) => {
    const r = el.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) return false;
    const cs = getComputedStyle(el);
    return cs.visibility !== "hidden" && cs.display !== "none" && Number(cs.opacity) > 0;
  };
  const dialogs = [...document.querySelectorAll('[role="dialog"]')].filter(shown);
  const scope = dialogs.at(-1) ?? document;
  let best = null;
  let bestScore = -1;
  for (const b of scope.querySelectorAll("button")) {
    if (b.disabled || b.tabIndex < 0 || b.closest("[hidden]") || b.classList.contains("hud-touch")) continue;
    if (!shown(b)) continue;
    const r = b.getBoundingClientRect();
    const badge = b.querySelector(".home-badge");
    const badgeShown = Boolean(badge && !badge.hidden && shown(badge));
    const score = (badgeShown ? 1e9 : 0) + (b.classList.contains("primary") ? 1e6 : 0) + r.width * r.height;
    if (score > bestScore) {
      best = b;
      bestScore = score;
    }
  }
  if (!best) return null;
  best.setAttribute("data-qa-cta", "1");
  return { name: (best.getAttribute("aria-label") || best.textContent || "").replace(/\s+/g, " ").trim() };
};

const withTimeout = (p, ms, what) =>
  Promise.race([p, new Promise((_, reject) => setTimeout(() => reject(new Error(`${what} timed out after ${ms} ms`)), ms))]);

async function clickCta(page, what) {
  const picked = await page.evaluate(PICK);
  if (!picked) throw new Error(`no call to action on ${what}`);
  await page.locator('[data-qa-cta="1"]').click();
  await page.evaluate(() => document.querySelectorAll("[data-qa-cta]").forEach((e) => e.removeAttribute("data-qa-cta")));
  return picked.name;
}

async function snap(h, results, caseId, name) {
  const file = path.join(results.evidenceDir, `${caseId}-${name}.png`.replaceAll(/[^\w.\-]+/g, "_"));
  const saved = await shot(h.page, file).catch(() => null);
  return saved ? rel(saved) : null;
}

/** Waits for the menu to be ready and enters Training through its "Start here" call to action. */
async function enterTraining(page) {
  await menuName(page).waitFor({ timeout: 15000 });
  const name = await clickCta(page, "menu");
  if (!/Training/.test(name)) throw new Error(`menu call to action is "${name}", not Training`);
  await page.locator(".training-text").waitFor({ state: "attached", timeout: 15000 });
  return name;
}

const lessonCount = (page) => page.locator(".training-count").textContent().then((t) => t?.trim() ?? "");

async function expectLesson(page, n) {
  await page.waitForFunction(
    ([n, total]) => document.querySelector(".training-count")?.textContent?.trim() === `${n} of ${total}`,
    [n, LESSONS],
    { timeout: 5000 },
  );
}

async function skipVisible(page) {
  const leave = button(page, "Leave");
  return (await leave.isVisible()) && (await leave.isEnabled());
}

/** One lesson: the count, the skip control, the chips and a screenshot. */
async function lessonStep(h, results, caseId, n) {
  await expectLesson(h.page, n);
  const skip = await skipVisible(h.page);
  const chips = await h.page.locator(".training-text .key").allTextContents();
  const shotFile = await snap(h, results, caseId, `lesson${n}`);
  return { n, skip, chips, shot: shotFile };
}

const lessonsOk = (seen) => seen.every((s) => s.skip);
const evidenceOf = (seen) => seen.map((s) => s.shot).filter(Boolean);

/** Sets pad buttons on the gamepad mock (PAD_INIT). */
const padSet = (page, index, pressed) =>
  page.evaluate(
    ([i, v]) => {
      window.__qaPad.buttons[i].pressed = v;
      window.__qaPad.buttons[i].value = v ? 1 : 0;
    },
    [index, pressed],
  );

async function awaitFrames(page) {
  await page.waitForFunction(() => window.__qa && window.__qa.found > 0, null, { timeout: 30000 });
}

/** Starts an input, then polls the local player's x until it moves MOVE_MIN from where it was. */
async function moveUntil(page, start, stop) {
  await awaitFrames(page);
  const x0 = await page.evaluate(() => window.__qa.x);
  await start();
  let at = null;
  try {
    const end = Date.now() + MOVE_WINDOW_MS;
    while (Date.now() < end) {
      const x = await page.evaluate(() => window.__qa.x);
      if (Math.abs(x - x0) > MOVE_MIN) {
        at = Date.now();
        break;
      }
      await sleep(30);
    }
  } finally {
    await stop();
  }
  return { at, x0 };
}

async function moveKeys(page) {
  for (const key of [RIGHT, LEFT]) {
    const r = await moveUntil(
      page,
      () => page.keyboard.down(key),
      () => page.keyboard.up(key),
    );
    if (r.at !== null) return r;
  }
  return { at: null, x0: null };
}

/** Touch stick hold to the left: CDP touch on chromium, pointer (mouse) events on the other engines. */
async function moveTouch(page, engine) {
  const pad = page.locator(".hud-stick");
  await pad.waitFor({ state: "visible", timeout: 10000 });
  const r = await pad.boundingBox();
  const cx = r.x + r.width / 2;
  const cy = r.y + r.height / 2;
  const left = { x: cx - r.width * 0.4, y: cy };
  if (engine === "chromium") {
    const cdp = await page.context().newCDPSession(page);
    const send = (type, points) => cdp.send("Input.dispatchTouchEvent", { type, touchPoints: points });
    return moveUntil(
      page,
      async () => {
        await send("touchStart", [{ x: cx, y: cy }]);
        await send("touchMove", [left]);
      },
      () => send("touchEnd", []),
    );
  }
  return moveUntil(
    page,
    async () => {
      await page.mouse.move(cx, cy);
      await page.mouse.down();
      await page.mouse.move(left.x, left.y);
    },
    () => page.mouse.up(),
  );
}

/** Cold path (T1-M desktop, T3-T portrait phone): CTAs until the first movement in Training. */
async function coldPath(s, results, caseId, { phone }) {
  const engine = s.env.browser.browserType().name();
  const h = await s.open(caseId, phone ? { phone: true } : {});
  await h.context.addInitScript(HOOK);
  const { page } = h;
  const welcome = page.getByRole("dialog", { name: "Welcome", exact: true });
  const evidence = [];
  const log = [];
  let steps = 0;
  const step = async (label) => {
    steps++;
    const f = await snap(h, results, caseId, `step${String(steps).padStart(2, "0")}-${label}`);
    if (f) evidence.push(f);
  };

  const t0 = Date.now();
  await page.goto(s.base);
  await page.waitForFunction(
    () => document.querySelector('[role="dialog"][aria-label="Welcome"]') || document.querySelector('input[placeholder="name"]'),
    null,
    { timeout: 15000 },
  );
  if ((await welcome.count()) > 0) {
    log.push(`splash:${await clickCta(page, "splash")}`);
    await step("splash");
    await welcome.waitFor({ state: "detached", timeout: 5000 });
  }
  log.push(`menu:${await enterTraining(page)}`);
  await step("menu");

  if (phone) {
    const gate = page.locator(".hud-rotate:not([hidden])");
    if (await gate.waitFor({ timeout: GATE_WAIT_MS }).then(() => true, () => false)) {
      log.push(`gate:${await clickCta(page, "rotate gate")}`);
      await step("gate");
      await sleep(GATE_SETTLE_MS);
      if (await gate.isVisible()) {
        // Full screen did not turn the phone: the player turns it, which is one more action.
        await withTimeout(page.setViewportSize(LANDSCAPE), 8000, "rotate");
        log.push("rotated");
        steps++;
      }
      await gate.waitFor({ state: "hidden", timeout: 8000 });
    }
  }

  const mv = phone ? await moveTouch(page, engine) : await moveKeys(page);
  if (mv.at === null) throw new Error(`no movement within ${MOVE_WINDOW_MS} ms of the movement input (x0 ${mv.x0})`);
  evidence.push(await snap(h, results, caseId, "first-movement"));
  const ttfmS = (mv.at - t0) / 1000;
  return {
    pass: true,
    detail: `${log.join(" > ")}; first movement ${ttfmS.toFixed(2)} s after navigation, ${steps} steps`,
    metrics: { "onboarding.ttfmS.proxy": Number(ttfmS.toFixed(2)), "onboarding.steps.proxy": steps, "onboarding.phone": phone ? 1 : 0 },
    evidence: evidence.filter(Boolean),
  };
}

/** K: keyboard only. Tab reaches Next, Enter advances; Finish leaves to the menu. */
async function completeKeyboard(s, results, caseId) {
  const h = await s.open(caseId);
  const { page } = h;
  await page.goto(s.base);
  await enterTraining(page);
  for (let i = 0; i < 10 && !(await page.evaluate(() => document.activeElement?.classList.contains("training-next"))); i++) {
    await page.keyboard.press("Tab");
  }
  if (!(await page.evaluate(() => document.activeElement?.classList.contains("training-next")))) throw new Error("Tab does not reach Next");
  const seen = [];
  for (let n = 1; n <= LESSONS; n++) {
    seen.push(await lessonStep(h, results, caseId, n));
    await page.keyboard.press("Enter");
  }
  await menuName(page).waitFor({ timeout: 5000 });
  keyboardChips.set(s.env.browser.browserType().name(), seen.map((x) => x.chips.join("|")));
  const pass = lessonsOk(seen);
  return {
    pass,
    detail: pass ? undefined : "Leave missing at some lesson step",
    metrics: { "onboarding.lessons.done": seen.length, "onboarding.skip.ok": seen.filter((x) => x.skip).length },
    evidence: evidenceOf(seen),
  };
}

/** M: keyboard movement at lesson 1, mouse Next; Leave is the skip at lesson 3; Training re-entered. */
async function completeMouse(s, results, caseId) {
  const h = await s.open(caseId);
  await h.context.addInitScript(HOOK);
  const { page } = h;
  await page.goto(s.base);
  await enterTraining(page);
  await lessonStep(h, results, caseId, 1);
  const mv = await moveKeys(page);
  const seen = [];
  for (let n = 1; n <= 3; n++) {
    seen.push(await lessonStep(h, results, caseId, n));
    await page.locator(".training-next").click();
  }
  // Skip: Leave at lesson 4 returns to the menu; Training starts over at lesson 1.
  await expectLesson(page, 4);
  const skipOk = await skipVisible(page);
  await button(page, "Leave").click();
  await menuName(page).waitFor({ timeout: 5000 });
  await navTo(page, "Training");
  await expectLesson(page, 1);
  const again = [];
  for (let n = 1; n <= LESSONS; n++) {
    again.push(await lessonStep(h, results, caseId, n));
    await page.locator(".training-next").click();
  }
  await menuName(page).waitFor({ timeout: 5000 });
  const all = [...seen, ...again];
  const pass = mv.at !== null && lessonsOk(all) && skipOk;
  return {
    pass,
    detail: `keyboard movement ${mv.at !== null ? "moved" : "did not move"}; skip at lesson 4 ${skipOk ? "ok" : "missing"}`,
    metrics: { "onboarding.lessons.done": again.length, "onboarding.skip.ok": all.filter((x) => x.skip).length + (skipOk ? 1 : 0) },
    evidence: evidenceOf(all),
  };
}

/** T: landscape phone (844x390). Touch stick moves; tap Next; the chips follow the touch profile. */
async function completeTouch(s, results, caseId) {
  const engine = s.env.browser.browserType().name();
  const h = await s.open(caseId, { phone: true, viewport: LANDSCAPE });
  await h.context.addInitScript(HOOK);
  const { page } = h;
  await page.goto(s.base);
  await dismissPhoneSplash(page);
  await enterTraining(page);
  await page.locator(".hud-stick").waitFor({ state: "visible", timeout: 10000 }).catch(() => undefined);
  const layer = {
    stick: await page.locator(".hud-stick").isVisible(),
    buttons: await page.locator(".hud-touch[data-action]").count(),
  };
  const mv = await moveTouch(page, engine);
  const seen = [];
  for (let n = 1; n <= LESSONS; n++) {
    seen.push(await lessonStep(h, results, caseId, n));
    const next = page.locator(".training-next");
    if (engine === "chromium") await next.tap();
    else {
      const r = await next.boundingBox();
      await page.mouse.click(r.x + r.width / 2, r.y + r.height / 2);
    }
  }
  await menuName(page).waitFor({ timeout: 5000 });
  const kChips = keyboardChips.get(engine);
  if (!kChips) throw new Error("no keyboard run to compare the chips with (trainK runs first)");
  const onKeys = seen.filter((x, i) => kChips[i] && x.chips.join("|") === kChips[i]).map((x) => x.n);
  const chipsFollow = onKeys.length === 0;
  const touchOk = mv.at !== null && layer.stick && layer.buttons > 0;
  const pass = touchOk && lessonsOk(seen) && chipsFollow;
  const gaps = [];
  if (!touchOk) gaps.push("touch controls did not move the character");
  if (!chipsFollow) gaps.push(`lesson chips show keyboard keys on the touch profile (lessons ${onKeys.join(", ")})`);
  return {
    pass,
    detail: gaps.length ? gaps.join("; ") : undefined,
    metrics: {
      "onboarding.lessons.done": seen.length,
      "onboarding.skip.ok": seen.filter((x) => x.skip).length,
      "onboarding.touch.buttons": layer.buttons,
      "onboarding.touch.moved": mv.at !== null ? 1 : 0,
      "onboarding.chips.touchProfile": chipsFollow ? 1 : 0,
    },
    evidence: evidenceOf(seen),
  };
}

/** G: gamepad mock. The d-pad moves the character; A is pressed on Next to test pad navigation. */
async function completeGamepad(s, results, caseId) {
  const h = await s.open(caseId);
  await h.context.addInitScript(HOOK);
  await h.context.addInitScript(PAD_INIT);
  const { page } = h;
  await page.goto(s.base);
  await enterTraining(page);
  const seen = [await lessonStep(h, results, caseId, 1)];
  const mv = await moveUntil(
    page,
    () => padSet(page, PAD_DPAD_RIGHT, true),
    () => padSet(page, PAD_DPAD_RIGHT, false),
  );
  await padSet(page, PAD_A, true);
  await sleep(400);
  await padSet(page, PAD_A, false);
  await sleep(200);
  const padAdvances = (await lessonCount(page)) !== `1 of ${LESSONS}`;
  // Pad A did not advance lesson 1: Next is clicked with the mouse so the run continues (a gap).
  if (!padAdvances) await page.locator(".training-next").click();
  for (let n = 2; n <= LESSONS; n++) {
    seen.push(await lessonStep(h, results, caseId, n));
    await page.locator(".training-next").click();
  }
  await menuName(page).waitFor({ timeout: 5000 });
  const pass = mv.at !== null && padAdvances;
  const gaps = [];
  if (mv.at === null) gaps.push("d-pad did not move the character");
  if (!padAdvances) gaps.push("gamepad A does not advance a lesson (Next is mouse or keyboard only)");
  return {
    pass,
    detail: gaps.length ? gaps.join("; ") : undefined,
    metrics: { "onboarding.pad.moved": mv.at !== null ? 1 : 0, "onboarding.pad.advances": padAdvances ? 1 : 0 },
    evidence: evidenceOf(seen),
  };
}

/** Splash once: Not now and Escape each close the Welcome sheet, and a reload shows none. */
async function splashOnce(s, results, caseId) {
  const welcome = (page) => page.getByRole("dialog", { name: "Welcome", exact: true });
  const evidence = [];
  const first = await s.open(`${caseId}-notnow`, { phone: true });
  await first.page.goto(s.base);
  await welcome(first.page).waitFor({ timeout: 10000 });
  const shownFirst = await welcome(first.page).count();
  evidence.push(await snap(first, results, caseId, "splash-first"));
  await welcome(first.page).getByRole("button", { name: "Not now", exact: true }).click();
  await welcome(first.page).waitFor({ state: "detached", timeout: 5000 });
  await first.page.reload();
  await menuName(first.page).waitFor({ timeout: 15000 });
  await sleep(1000);
  const shownReload = await welcome(first.page).count();

  const second = await s.open(`${caseId}-escape`, { phone: true });
  await second.page.goto(s.base);
  await welcome(second.page).waitFor({ timeout: 10000 });
  await second.page.keyboard.press("Escape");
  await welcome(second.page).waitFor({ state: "detached", timeout: 5000 });
  await second.page.reload();
  await menuName(second.page).waitFor({ timeout: 15000 });
  await sleep(1000);
  const shownEscapeReload = await welcome(second.page).count();

  const pass = shownFirst === 1 && shownReload === 0 && shownEscapeReload === 0;
  return {
    pass,
    detail: `shown on first load ${shownFirst}, after Not now + reload ${shownReload}, after Escape + reload ${shownEscapeReload}`,
    metrics: { "onboarding.splash.shown": shownFirst, "onboarding.splash.afterReload": shownReload + shownEscapeReload },
    evidence: evidence.filter(Boolean),
  };
}

for (const engine of selectedEngines()) {
  const browser = await launchEngine(engine);
  const results = new Results("onboarding", engine);
  const srv = await startServer();
  const base = srv.base;
  const run = (id, fn) => results.case(id, fn, { browser, base });

  await run("coldT1M", (s) => coldPath(s, results, "coldT1M", { phone: false }));
  await run("coldT3T", (s) => coldPath(s, results, "coldT3T", { phone: true }));
  await run("trainK", (s) => completeKeyboard(s, results, "trainK"));
  await run("trainM", (s) => completeMouse(s, results, "trainM"));
  await run("trainG", (s) => completeGamepad(s, results, "trainG"));
  await run("trainT", (s) => completeTouch(s, results, "trainT"));
  await run("splashOnce", (s) => splashOnce(s, results, "splashOnce"));

  results.save();
}

writeIndex();
await runCleanups();
