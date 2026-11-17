// One capture: a page state at one (engine, theme, viewport row, axis, renderer). Writes
// <out>/<engine>/<theme>/<row>[-<axis>][-<renderer>]/<state>.png and .json with the metrics named in
// thresholds.json. measureState() is the whole measurement; the validate.mjs self-test runs the same
// code on fixtures.

import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { Scenario, dismissPhoneSplash, nextClientIp } from "../e2e/lib.mjs";
import { watchPage } from "./lib-qa.mjs";
import { axeCounts, domMeasure, nextFrames, reducedMotion, reflowDetails, reflowIssues } from "./metrics.mjs";
import { focusWalk } from "./focus.mjs";
import { analyseScreenshot } from "./image.mjs";
import { isTouch, profileOf } from "./presets.mjs";

/**
 * Theme modes. `scheme` is the OS colour scheme emulated for the context; `pref` is the app's own
 * theme pref (localStorage neobox.prefs). "system" leaves the app pref unset, so the app follows
 * the emulated OS scheme (dark, the path that breaks most often).
 */
export const THEMES = {
  light: { scheme: "light", pref: "light" },
  dark: { scheme: "dark", pref: "dark" },
  system: { scheme: "dark", pref: null },
};

/**
 * Settings axes (rubric Tier A). reduce / forced / more are emulated media; palette-* sets the
 * Palette pref. "none" is the plain capture.
 */
export const AXES = ["none", "reduce", "forced", "more", "palette-deuteranopia", "palette-protanopia", "palette-tritanopia"];

/** Renderers for canvas screens. webgl2 hides navigator.gpu before the app boots; webgpu is chromium only. */
export const RENDERERS = ["webgpu", "webgl2"];

/** Relative font-size growth the textScale pass must reach (html font-size 200%). */
const MIN_FONT_RATIO = 1.9;

/** Any URL a console line names (Chromium and Firefox print the failed URL inside the text), without closing punctuation. */
const URL_IN_TEXT = /\b(?:https?|wss?):\/\/[^\s"'()<>[\]{}]+/g;

/**
 * True when a console line or warning is one the state's own fault produced: a URL it names (its location, or a URL in
 * the text) matches `h.expected`, or its text matches an anchored `h.expectedWarnings` pattern (app log lines with no URL).
 */
function isInduced(h, text, url = "") {
  const named = [url, ...(text.match(URL_IN_TEXT) ?? []).map((u) => u.replace(/[.,;:]+$/, ""))];
  return named.some((u) => u !== "" && (h.expected ?? []).some((re) => re.test(u))) || (h.expectedWarnings ?? []).some((re) => re.test(text));
}

/**
 * Attaches the robustness listeners to a page; problems and warnings land on `handle`. A state injects failures on
 * purpose and says which: `handle.expected` (URL patterns: the dropped socket, a failed or blocked request) and
 * `handle.expectedWarnings` (anchored text for app log lines the fault produces). Such lines land in `handle.induced`
 * instead of counting as defects.
 */
export function trackPage(page, handle) {
  handle.page = page;
  handle.problems = handle.problems ?? [];
  handle.induced = handle.induced ?? [];
  page.setDefaultTimeout(15_000);
  const expectedUrl = (url) => (handle.expected ?? []).some((re) => re.test(url));
  page.on("pageerror", (err) => handle.problems.push(`${handle.label}: page error: ${err.message}`));
  page.on("console", (msg) => {
    if (msg.type() !== "error") return;
    const url = msg.location().url ?? "";
    const text = msg.text();
    const line = `${handle.label}: console error: ${text}${url ? ` (${url})` : ""}`;
    (isInduced(handle, text, url) ? handle.induced : handle.problems).push(line);
  });
  page.on("dialog", (dialog) => {
    handle.problems.push(`${handle.label}: unexpected dialog: ${dialog.message()}`);
    void dialog.dismiss();
  });
  watchPage(handle, { expected: expectedUrl });
  return handle;
}

/** Init-script arguments for a capture: app prefs, WebGL-only renderer and the gamepad mock. */
function initArgs({ name, theme, axis, renderer, row }) {
  const prefs = {};
  if (THEMES[theme].pref) prefs.theme = THEMES[theme].pref;
  if (axis.startsWith("palette-")) prefs.palette = axis.slice("palette-".length);
  return {
    guest: name ?? null,
    prefs: Object.keys(prefs).length ? prefs : null,
    noGpu: renderer === "webgl2",
    gamepad: row.input === "G",
  };
}

/**
 * A Scenario whose contexts take the capture's viewport row, colour scheme, settings axis, renderer
 * and input. `cap` = { engine, theme, row, axis, renderer }.
 */
export class QaScenario extends Scenario {
  constructor(name, env, cap) {
    super(name, env);
    this.cap = cap;
  }

  async open(label, { name, ip: forcedIp, clipboard = false, serviceWorkers } = {}) {
    const { engine, theme, row, axis, renderer } = this.cap;
    if (!THEMES[theme]) throw new Error(`unknown theme "${theme}" (known: ${Object.keys(THEMES).join(", ")})`);
    if (!AXES.includes(axis)) throw new Error(`unknown axis "${axis}" (known: ${AXES.join(", ")})`);
    if (renderer === "webgpu" && engine !== "chromium") throw new Error(`webgpu is unavailable on ${engine}`);
    if (row.notch && engine !== "chromium") throw new Error(`notch row ${row.id} needs chromium (safe-area override)`);
    const ip = forcedIp ?? nextClientIp();
    const touch = isTouch(row);
    const options = {
      viewport: { width: row.W, height: row.H },
      deviceScaleFactor: row.dsf,
      colorScheme: THEMES[theme].scheme,
      acceptDownloads: true,
      extraHTTPHeaders: { "X-Forwarded-For": ip },
    };
    if (axis === "reduce") options.reducedMotion = "reduce";
    if (axis === "forced") options.forcedColors = "active";
    if (axis === "more") options.contrast = "more";
    // Firefox drops synthetic mouse input under isMobile, so it gets hasTouch alone (as e2e/lib.mjs phoneOptions):
    // that alone makes (pointer: coarse) match there (probe: fix3/pointerprobe.log). Other engines also get isMobile.
    if (engine === "firefox") Object.assign(options, { hasTouch: touch });
    else Object.assign(options, { isMobile: touch, hasTouch: touch });
    // A service worker fetches on its own, past context.route: a state that stubs a request sets "block".
    if (serviceWorkers) options.serviceWorkers = serviceWorkers;
    const context = await this.env.browser.newContext(options);
    // As e2e/lib.mjs: the clipboard is granted where the engine accepts the grant; elsewhere the app shows the link in its toast.
    if (clipboard && this.env.browser.clipboard) {
      await context.grantPermissions(["clipboard-read", "clipboard-write"], { origin: this.base });
      await context.addInitScript(() => {
        Object.defineProperty(navigator, "share", { value: undefined, configurable: true });
      });
    }
    await context.addInitScript((args) => {
      if (args.guest && localStorage.getItem("neobox.name") === null) localStorage.setItem("neobox.name", args.guest);
      if (args.prefs && localStorage.getItem("neobox.prefs") === null) localStorage.setItem("neobox.prefs", JSON.stringify(args.prefs));
      if (args.noGpu) Object.defineProperty(navigator, "gpu", { value: undefined, configurable: true });
      if (args.gamepad) {
        const pad = {
          id: "neobox-qa Mock Gamepad",
          index: 0,
          connected: true,
          mapping: "standard",
          timestamp: 0,
          axes: [0, 0, 0, 0],
          buttons: Array.from({ length: 17 }, () => ({ pressed: false, touched: false, value: 0 })),
        };
        Object.defineProperty(navigator, "getGamepads", { value: () => [pad], configurable: true });
      }
    }, initArgs({ name, theme, axis, renderer, row }));
    const page = await context.newPage();
    const handle = trackPage(page, { label, context, ip, problems: [] });
    if (row.notch) {
      // Safe-area insets the device would report (notch top, home-indicator bottom); chromium only.
      const cdp = await context.newCDPSession(page);
      await cdp.send("Emulation.setSafeAreaInsetsOverride", {
        insets: { top: row.notch.top, bottom: row.notch.bottom, left: 0, right: 0 },
      });
    }
    this.handles.push(handle);
    return handle;
  }
}

/**
 * Browser-originated console warnings the app does not cause, matched on the whole text (Firefox's wrapper included).
 * The list is documented in client/qa/README.md; a line that only contains these words is app code and counts.
 */
const BROWSER_WARNINGS = [
  /^\[JavaScript Warning: "WebGPU is disabled by blocklist\." \{file: "[^"]*" line: \d+\}\]$/,
  /^\[JavaScript Warning: "The execution of microtasks on this page was reordered to avoid unsafe execution\." \{file: "[^"]*" line: \d+\}\]$/,
  /^\[JavaScript Warning: "Request for fullscreen was denied because requesting element is not in the currently focused tab\." \{file: "[^"]*" line: \d+\}\]$/,
  /^Service Worker registration blocked by Playwright$/,
];

/** Warning classes: the browser's own notice, the state's injected fault, or the app (the only class that counts). */
function warningClass(h, warning) {
  const text = warning.startsWith(`${h.label}: `) ? warning.slice(h.label.length + 2) : warning;
  if (BROWSER_WARNINGS.some((re) => re.test(text))) return "browser";
  if (isInduced(h, text)) return "induced";
  return "app";
}

/** Warning texts the app caused, across the handles. */
function appWarnings(handles) {
  return handles.flatMap((h) => (h.warnings ?? []).filter((w) => warningClass(h, w) === "app"));
}

/** Robustness counts across every page the scenario opened (host and guest in a match). */
export function robustness(handles) {
  const problems = handles.flatMap((h) => h.problems);
  return {
    "console.errors": problems.filter((p) => p.includes(": console error:")).length,
    "console.warnings": appWarnings(handles).length,
    "page.errors": problems.filter((p) => p.includes(": page error:") || p.includes(": unexpected dialog:")).length,
    "net.failed": handles.reduce((n, h) => n + (h.netFailed?.length ?? 0), 0),
  };
}

/** Expands every visible string by 40% (pseudo-localisation): text nodes get a filler suffix. */
async function pseudoLocalise(page) {
  await page.evaluate(() => {
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    const nodes = [];
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      if (n.parentElement?.closest("script,style,noscript")) continue;
      if (n.textContent.trim()) nodes.push(n);
    }
    window.__plOriginal = new WeakMap();
    for (const n of nodes) {
      const original = n.textContent.length;
      const len = n.textContent.trim().length;
      n.textContent = `${n.textContent} ${"·".repeat(Math.ceil(len * 0.4))}`;
      window.__plOriginal.set(n, original);
    }
  });
}

/**
 * Scales the root font to 200% of the browser default until removeRootScale. An inline !important declaration
 * beats every stylesheet rule, so the app's --text-scale calc (and any !important rule) cannot undo it.
 */
async function addRootScale(page) {
  await page.evaluate(() => document.documentElement.style.setProperty("font-size", "200%", "important"));
}

/** Removes the inline root font set by addRootScale. */
const removeRootScale = (page) => page.evaluate(() => document.documentElement.style.removeProperty("font-size"));

/** The root font size in px, as the page computes it right now. */
const rootFontPx = (page) => page.evaluate(() => parseFloat(getComputedStyle(document.documentElement).fontSize));

/** True when a 200% root font took effect (relative growth of at least MIN_FONT_RATIO). */
const fontRatioOk = (before, after) => before > 0 && after / before >= MIN_FONT_RATIO;

/** Layout pass at another viewport; restores the row's viewport before returning. Returns the domMeasure result. */
async function reflowAt(page, row, opts, vw, vh) {
  await page.setViewportSize({ width: vw, height: vh });
  await nextFrames(page);
  const dom = await page.evaluate(domMeasure, opts);
  await page.setViewportSize({ width: row.W, height: row.H });
  await nextFrames(page);
  return dom;
}

/**
 * Records one reflow pass: the problem count under `key`, and the problems behind it (element
 * details) under the same key. A failed precondition (`failure`, e.g. a font scale that did not
 * apply) counts as one more problem and is recorded with the details.
 */
function recordReflow(metrics, details, key, dom, failure = null) {
  metrics[key] = reflowIssues(dom) + (failure ? 1 : 0);
  details[key] = [...reflowDetails(dom), ...(failure ? [failure] : [])];
}

/**
 * Every measurement of one page at one viewport row. The page must already show the state.
 * Returns { metrics, details, info, png }. Leaves the viewport as it found it.
 */
export async function measureState(page, { row, fit = false, dialog = false, handles = [], axis = "none", expectTheme = null, lap = () => {} }) {
  const opts = { profile: profileOf(row), fit, notch: row.notch ?? null, expectTheme, forced: axis === "forced" };

  if (row.pseudo) await pseudoLocalise(page);
  // Root-font rows measure with the 200% root font in place (the row itself is the scaled state).
  const fontBefore = await rootFontPx(page);
  if (row.rootScale) await addRootScale(page);

  // Layout, edges, targets, labels; then the screenshot on the same frame.
  const dom = await page.evaluate(domMeasure, opts);
  const png = await page.screenshot({ animations: "disabled", caret: "hide" });
  const pixels = analyseScreenshot(png, { W: row.W, H: row.H, texts: dom.texts, controls: dom.controls });
  const metrics = { ...dom.metrics, ...pixels.metrics };
  const details = { ...dom.details, ...pixels.details };
  lap("dom+pixels");
  if (axis === "more") metrics["contrast.more.fails"] = (pixels.metrics["contrast.fails"] ?? 0) + (pixels.metrics["contrast.nonText.fails"] ?? 0);

  // axe-core (WCAG 2.2 AA + best practice), keyed as axe.<impact>.
  const axe = await axeCounts(page);
  for (const impact of ["critical", "serious", "moderate", "minor"]) metrics[`axe.${impact}`] = axe[impact] ?? 0;
  details["axe.rules"] = axe.rules.slice(0, 60);
  lap("axe");

  const motion = await reducedMotion(page, axis === "reduce" ? "reduce" : "no-preference");
  metrics["reducedMotion.animating"] = motion.count;
  details["reducedMotion.animating"] = motion.names;
  lap("reducedMotion");

  // Keyboard: Tab once through the order (focus visibility, order jumps, dialog trap).
  const focus = await focusWalk(page, { dialog, indicator: row.id === "T1-K" });
  Object.assign(metrics, focus.metrics);
  Object.assign(details, focus.details);
  metrics["focus.steps"] = focus.steps;
  lap("focus");

  // Zoom rows are already the effective viewport (Z200-M, Z400-M), so their main pass is the zoom result.
  if (row.zoom === 200) recordReflow(metrics, details, "zoom200.issues", dom);
  if (row.zoom === 400) recordReflow(metrics, details, "zoom400.issues", dom);
  if (row.rootScale) {
    const applied = fontRatioOk(fontBefore, await rootFontPx(page));
    recordReflow(metrics, details, "textScale.issues", dom, applied ? null : `root font ${fontBefore}px: 200% scale not applied`);
  }
  if (row.rootScale) await removeRootScale(page);
  lap("zoom-and-textScale-setup");

  // Other rows: 200% zoom = CSS viewport halved; text scale = root font doubled, checked to take effect.
  if (!row.zoom) recordReflow(metrics, details, "zoom200.issues", await reflowAt(page, row, opts, Math.round(row.W / 2), Math.round(row.H / 2)));
  lap("zoom200");
  if (!row.zoom && !row.rootScale) {
    const before = await rootFontPx(page);
    await addRootScale(page);
    const after = await rootFontPx(page);
    const applied = fontRatioOk(before, after);
    recordReflow(metrics, details, "textScale.issues", await page.evaluate(domMeasure, opts), applied ? null : `root font ${before}px -> ${after}px: scale not applied`);
    await removeRootScale(page);
  }
  lap("textScale");

  // WCAG 1.4.12 text spacing: line-height 1.5, letter-spacing .12em, word-spacing .16em, paragraph spacing 2em.
  if (row.textSpacing) {
    const style = await page.addStyleTag({
      content: "*{line-height:1.5!important;letter-spacing:.12em!important;word-spacing:.16em!important} p{margin-bottom:2em!important}",
    });
    recordReflow(metrics, details, "textSpacing.issues", await page.evaluate(domMeasure, opts));
    await style.evaluate((node) => node.remove());
  }
  lap("textSpacing");

  Object.assign(metrics, robustness(handles));
  // Every warning text, tagged by class; only `app` counts toward console.warnings.
  const warnings = handles.flatMap((h) => (h.warnings ?? []).map((w) => `${warningClass(h, w)} | ${w}`));
  if (warnings.length) details["console.warnings"] = warnings;
  // What each state failed on purpose, and every other failure, so an instrument verdict can be checked.
  const induced = handles.flatMap((h) => [...(h.induced ?? []), ...(h.netExpected ?? [])]);
  if (induced.length) details.induced = induced;
  const problems = handles.flatMap((h) => h.problems);
  if (problems.length) details.problems = problems;
  const netFailed = handles.flatMap((h) => h.netFailed ?? []);
  if (netFailed.length) details.netFailed = netFailed;
  return { metrics, details, info: dom.info, png };
}

/**
 * Lets fonts load, the boot overlay leave (app.ts start() fades #boot for 180ms, and its opacity
 * transition would otherwise be measured as running) and the first frames paint. The game canvas
 * keeps moving, so there is no quiet wait.
 */
async function settle(page) {
  await page.evaluate(() => document.fonts.ready.then(() => undefined));
  await page.waitForFunction(() => {
    const boot = document.getElementById("boot");
    return boot === null || boot.hidden;
  });
  // The screen is idle when no screen change is in progress (transition.ts marks the entering and the frozen leaving
  // copy; the copy is removed 160 ms after it starts), no animation or transition is pending or running with a finite
  // length, no element that is faded or transformed is still moving (a timer-driven fade has no CSS animation, and
  // axe blends the colours of an element with its translucent ancestors), and that holds for three frames in a row.
  // Infinite animations (the game canvas, spinners) are allowed.
  await page.evaluate(() => {
    window.__idleFrames = 0;
    window.__idleSig = null;
  });
  await page.waitForFunction(
    () => {
      const busy =
        document.querySelector(".screen-in, .screen-out") !== null ||
        document
          .getAnimations()
          .some((a) => a.playState === "pending" || (a.playState === "running" && a.effect?.getComputedTiming().endTime !== Infinity));
      let sig = "";
      for (const el of document.querySelectorAll("body *")) {
        const cs = getComputedStyle(el);
        if (cs.opacity === "1" && cs.transform === "none") continue;
        const r = el.getBoundingClientRect();
        sig += `${cs.opacity}|${cs.transform}|${cs.visibility}|${r.x},${r.y},${r.width},${r.height};`;
      }
      const stable = sig === window.__idleSig;
      window.__idleSig = sig;
      window.__idleFrames = busy || !stable ? 0 : window.__idleFrames + 1;
      return window.__idleFrames >= 3;
    },
    null,
    { timeout: 10000, polling: "raf" },
  );
  await nextFrames(page);
}

/** The metric-free folder name for one capture: row, then axis and renderer when they are not the default. */
export function captureDir(outRoot, { engine, theme, row, axis = "none", renderer = null }) {
  const name = [row.id, axis !== "none" ? axis : null, renderer].filter(Boolean).join("-");
  return path.join(outRoot, engine, theme, name);
}

/**
 * Captures one state. Never throws: a failure is written into the record as `error`, so one
 * broken state does not stop a sweep. Returns the record.
 */
export async function captureOne({ base, browser, engine, theme, row, state, outRoot, axis = "none", renderer = null }) {
  const dir = captureDir(outRoot, { engine, theme, row, axis, renderer });
  mkdirSync(dir, { recursive: true });
  const profile = profileOf(row);
  const record = {
    engine,
    theme,
    row: row.id,
    axis,
    renderer,
    viewport: { W: row.W, H: row.H },
    dsf: row.dsf,
    profile,
    state: state.id,
    fit: state.fit,
    dialog: state.dialog,
    metrics: {},
    details: {},
    info: {},
  };
  const s = new QaScenario(state.id, { base, browser }, { engine, theme, row, axis, renderer });
  // Wall-clock per phase (ms), so sweep throughput can be read per cell.
  const timing = {};
  let mark = performance.now();
  const lap = (name) => {
    const now = performance.now();
    timing[name] = Math.round(now - mark);
    mark = now;
  };
  try {
    const h = await state.prepare(s);
    lap("prepare");
    if (isTouch(row) && !state.splash) await dismissPhoneSplash(h.page);
    await settle(h.page);
    lap("settle");
    record.navigatorGpu = await h.page.evaluate(() => Boolean(navigator.gpu));
    // The app's own theme is the resolved scheme: "system" follows the emulated OS scheme.
    const expectTheme = theme === "system" ? THEMES.system.scheme : theme;
    const m = await measureState(h.page, { row, fit: state.fit, dialog: state.dialog, handles: s.handles, axis, expectTheme, lap });
    lap("measure");
    writeFileSync(path.join(dir, `${state.id}.png`), m.png);
    Object.assign(record.metrics, m.metrics);
    record.details = m.details;
    record.info = { ...(h.info ?? {}), ...m.info };
  } catch (err) {
    record.error = err instanceof Error ? err.message.split("\n")[0] : String(err);
  } finally {
    await s.close();
    lap("close");
  }
  record.timing = timing;
  writeFileSync(path.join(dir, `${state.id}.json`), `${JSON.stringify(record, null, 2)}\n`);
  return record;
}
