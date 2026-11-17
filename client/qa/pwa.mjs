// PWA instrument: the installed-app manifest (pwa.manifest.ok), the home menu opened in
// display-mode standalone from the manifest start_url (menu-standalone, T3 phone, light and dark),
// and audio that starts before the first gesture (audio.startedBeforeGesture).
//
// Run: cd client && bun qa/pwa.mjs            (QA_ENGINES=chromium to limit engines)
// Output: <QA_OUT>/pwa-<engine>.{json,md}, evidence under <QA_OUT>/evidence/pwa-<engine>/.
// Self-tests (QA_SELF_TEST): manifest (display, theme colour and maskable icon broken),
// standalone (manifest start_url points at a missing page), audio (a muted media element plays
// at load, before any gesture). A working instrument must fail on its self-test.
// display-mode is probed through a matchMedia override: CDP display-mode emulation has no effect here. menu-standalone runs on chromium; other engines are info (N/A probe).

import {
  Results,
  launchEngine,
  menuName,
  runCleanups,
  selectedEngines,
  selfTestMode,
  sleep,
  startServer,
  watchPage,
  writeIndex,
} from "./lib-qa.mjs";

const SELF = selfTestMode();
const PREFS_KEY = "neobox.prefs"; // client/src/storage-keys.ts PREFS_KEY
const MISSING_START = "/qa-missing-start";
const AUTOPLAY_ERR = /autoplay|NotAllowedError|play\(\) failed|not allowed to start/i;

/** Fetches a URL inside the page, so page.route fault injection applies to it. */
async function pageFetch(page, url, asText = false) {
  return page.evaluate(
    async ({ u, asText }) => {
      const r = await fetch(u, { cache: "no-store" });
      const out = { status: r.status, type: r.headers.get("content-type") ?? "" };
      if (asText) out.text = await r.text();
      else out.head = Array.from(new Uint8Array(await r.arrayBuffer()).slice(0, 24));
      return out;
    },
    { u: url, asText },
  );
}

/** Width and height from a PNG's IHDR chunk, or null when the bytes are not a PNG. */
function pngSize(head) {
  const sig = [137, 80, 78, 71, 13, 10, 26, 10];
  if (!head || sig.some((b, i) => head[i] !== b)) return null;
  const u32 = (o) => ((head[o] << 24) | (head[o + 1] << 16) | (head[o + 2] << 8) | head[o + 3]) >>> 0;
  return { w: u32(16), h: u32(20) };
}

/**
 * Checks the manifest the page links, fetched through the page. Returns the problems found
 * (empty when valid) and the parsed values the metrics report.
 */
async function manifestCheck(page) {
  const links = await page.evaluate(() => ({
    manifest: document.querySelector('link[rel="manifest"]')?.href ?? null,
    theme: document.querySelector('meta[name="theme-color"]')?.content ?? null,
    apple: document.querySelector('link[rel="apple-touch-icon"]')?.href ?? null,
  }));
  if (!links.manifest) return { problems: ["index.html has no link rel=manifest"], values: {} };
  const m = await pageFetch(page, links.manifest, true);
  if (m.status !== 200) return { problems: [`manifest ${links.manifest} gives HTTP ${m.status}`], values: {} };
  let j;
  try {
    j = JSON.parse(m.text);
  } catch (err) {
    return { problems: [`manifest is not JSON: ${err.message}`], values: {} };
  }
  const problems = [];
  for (const k of ["name", "short_name"]) {
    if (typeof j[k] !== "string" || !j[k].trim()) problems.push(`manifest ${k} missing`);
  }
  let startUrl = null;
  if (!j.start_url) problems.push("start_url missing");
  else {
    startUrl = new URL(j.start_url, links.manifest).href;
    const s = await pageFetch(page, startUrl, true);
    if (s.status !== 200 || !s.type.includes("text/html")) {
      problems.push(`start_url ${j.start_url} gives HTTP ${s.status} ${s.type}`);
    }
  }
  // The app rewrites meta theme-color at runtime per theme (client/src/theme.ts), so compare with the static HTML.
  const indexHtml = await pageFetch(page, new URL("/", links.manifest).href, true);
  const staticTheme = /name="theme-color"\s+content="([^"]+)"/.exec(indexHtml.text ?? "")?.[1] ?? null;
  if (j.display !== "standalone") problems.push(`display is ${j.display}, expected standalone`);
  if (!j.theme_color) problems.push("theme_color missing");
  else if (staticTheme && j.theme_color.toLowerCase() !== staticTheme.toLowerCase()) {
    problems.push(`theme_color ${j.theme_color} differs from index.html meta theme-color ${staticTheme}`);
  }
  if (!j.background_color) problems.push("background_color missing");
  const icons = Array.isArray(j.icons) ? j.icons : [];
  if (icons.length === 0) problems.push("no icons");
  for (const ic of icons) {
    const r = await pageFetch(page, new URL(ic.src, links.manifest).href);
    if (r.status !== 200) {
      problems.push(`icon ${ic.src} gives HTTP ${r.status}`);
      continue;
    }
    const dim = pngSize(r.head);
    if (!dim) problems.push(`icon ${ic.src} is not a PNG (${r.type})`);
    else if (ic.sizes !== `${dim.w}x${dim.h}`) problems.push(`icon ${ic.src} is ${dim.w}x${dim.h}, declared ${ic.sizes}`);
  }
  if (!icons.some((i) => i.sizes === "192x192")) problems.push("no 192x192 icon");
  if (!icons.some((i) => i.sizes === "512x512")) problems.push("no 512x512 icon");
  if (!icons.some((i) => (i.purpose ?? "any").split(/\s+/).includes("maskable"))) problems.push("no maskable icon");
  if (links.apple) {
    const a = await pageFetch(page, links.apple);
    if (a.status !== 200) problems.push(`apple-touch-icon gives HTTP ${a.status}`);
  }
  return {
    problems,
    values: {
      name: j.name,
      display: j.display,
      startUrl,
      themeColor: j.theme_color,
      backgroundColor: j.background_color,
      icons: icons.length,
    },
  };
}

/** Self-test faults, installed on the context before the page loads. */
async function installFault(context) {
  if (SELF !== "manifest" && SELF !== "standalone") return;
  await context.route("**/*.webmanifest", async (route) => {
    const res = await route.fetch();
    const j = await res.json();
    if (SELF === "manifest") {
      j.display = "browser";
      j.theme_color = "#000000";
      j.icons = j.icons.filter((i) => !(i.purpose ?? "").includes("maskable"));
    } else {
      j.start_url = MISSING_START;
    }
    await route.fulfill({ status: 200, contentType: "application/manifest+json", body: JSON.stringify(j) });
  });
  if (SELF === "standalone") {
    await context.route(`**${MISSING_START}*`, (route) =>
      route.fulfill({ status: 404, contentType: "text/plain", body: "missing" }),
    );
  }
}

async function manifestCase(s, base) {
  const h = await s.open("manifest");
  watchPage(h);
  await installFault(h.context);
  await h.page.goto(base);
  await menuName(h.page).waitFor();
  const { problems, values } = await manifestCheck(h.page);
  const ok = problems.length === 0;
  return {
    pass: ok,
    detail: ok ? `valid: ${values.display}, ${values.icons} icons` : problems.join("; "),
    metrics: {
      "pwa.manifest.ok": ok ? 1 : 0,
      "pwa.manifest.problems": problems.length,
      "pwa.manifest.themeColor": values.themeColor ?? null,
      "pwa.manifest.display": values.display ?? null,
    },
  };
}

/** The home menu in display-mode standalone, reached through the manifest start_url. */
async function standaloneCase(s, base, theme, chromium) {
  const h = await s.open(`standalone-${theme}`, { phone: true });
  watchPage(h);
  await installFault(h.context);
  await h.context.addInitScript(
    ({ key, t }) => {
      if (localStorage.getItem(key) === null) localStorage.setItem(key, JSON.stringify({ theme: t }));
    },
    { key: PREFS_KEY, t: theme },
  );
  await h.page.emulateMedia({ colorScheme: theme });
  await h.page.goto(base);
  const { problems, values } = await manifestCheck(h.page);
  if (!chromium) {
    const dm = await h.page.evaluate(() => matchMedia("(display-mode: standalone)").matches);
    return {
      detail: `N/A probe: display-mode emulation is CDP-only (chromium); matchMedia standalone=${dm}`,
      metrics: { "menu-standalone.na": 1, "menu-standalone.matchMediaStandalone": dm ? 1 : 0 },
    };
  }
  // CDP Emulation.setEmulatedMedia ignores the display-mode feature in this Chromium (probed: no change
  // to matchMedia), and the app reads no display-mode query (grep client/src: none). The probe therefore
  // overrides matchMedia for that one query, so the menu loads from the manifest start_url as an installed app would.
  await h.context.addInitScript(() => {
    const mm = window.matchMedia.bind(window);
    const inert = { addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} };
    window.matchMedia = (q) =>
      /display-mode:\s*standalone/.test(q) ? { ...inert, matches: true, media: q, onchange: null } : mm(q);
  });
  await h.page.goto(values.startUrl ?? base);
  const standalone = await h.page.evaluate(() => matchMedia("(display-mode: standalone)").matches);
  const meta = await h.page.evaluate(() => document.querySelector('meta[name="theme-color"]')?.content ?? null);
  const shown = await menuName(h.page)
    .waitFor({ timeout: 15000 })
    .then(() => true, () => false);
  const ok = standalone && shown && problems.length === 0;
  return {
    pass: ok,
    detail: ok
      ? `menu shown in standalone at ${values.startUrl}`
      : [!standalone && "display-mode standalone not matched", !shown && "menu not shown at start_url", ...problems]
          .filter(Boolean)
          .join("; "),
    metrics: {
      "menu-standalone.displayModeOverride": standalone ? 1 : 0,
      "menu-standalone.menuShown": shown ? 1 : 0,
      "menu-standalone.manifestProblems": problems.length,
      "menu-standalone.runtimeMetaThemeColor": meta,
    },
  };
}

/**
 * Runs before any page script. Before the first pointerdown or keydown, records AudioContexts that
 * enter `running` and play() calls on audible elements that resolve. The muteAudio harness silences every
 * element, so `muted` and `volume` are read on entry to play(), before the harness acts: an element the
 * app left unmuted counts as audible, a muted one (harness or app) does not.
 * Self-test (QA_SELF_TEST=audio): play() is faked to resolve and an audible element plays at load.
 */
function audioProbe(arg) {
  window.__qaGesture = false;
  window.__qaEarly = [];
  window.__qaCtxAfter = 0;
  window.__qaPlayCalls = 0;
  const gesture = () => {
    window.__qaGesture = true;
  };
  window.addEventListener("pointerdown", gesture, true);
  window.addEventListener("keydown", gesture, true);
  const early = (what) => {
    if (!window.__qaGesture) window.__qaEarly.push(what);
  };
  const Ctor = window.AudioContext ?? window.webkitAudioContext;
  if (Ctor) {
    window.AudioContext = class extends Ctor {
      constructor(...args) {
        super(...args);
        if (window.__qaGesture) window.__qaCtxAfter++;
        if (this.state === "running") early("AudioContext running at construction");
        this.addEventListener("statechange", () => {
          if (this.state === "running") early("AudioContext entered running");
        });
      }
    };
  }
  // Self-test fault: the browser's autoplay policy refuses play() here without a gesture, so the fault is a
  // play() that resolves (what a regression that starts media early would look like).
  if (arg.selfTest === "audio") HTMLMediaElement.prototype.play = () => Promise.resolve();
  const play = HTMLMediaElement.prototype.play;
  HTMLMediaElement.prototype.play = function (...args) {
    const audible = !this.muted && this.volume > 0;
    if (!window.__qaGesture) window.__qaPlayCalls++;
    return play.apply(this, args).then((v) => {
      if (audible) early(`audible media play() resolved: ${this.currentSrc || this.src}`);
      return v;
    });
  };
  if (arg.selfTest === "audio") void new Audio(`${arg.base}/sfx/click_001.mp3`).play();
}

async function audioCase(s, base) {
  const h = await s.open("audio");
  watchPage(h);
  await h.context.addInitScript(audioProbe, { selfTest: SELF, base });
  await h.page.goto(base);
  await menuName(h.page).waitFor();
  await sleep(2500);
  const early = await h.page.evaluate(() => window.__qaEarly);
  // A keypress is a gesture: the app's sfx.unlock then creates its AudioContext. Proves the probe sees contexts.
  await h.page.keyboard.press("Shift");
  await sleep(300);
  const ctxAfter = await h.page.evaluate(() => window.__qaCtxAfter);
  const autoplayMsgs = h.problems.filter((p) => AUTOPLAY_ERR.test(p));
  const autoplayErrors = autoplayMsgs.length;
  const ok = early.length === 0 && autoplayErrors === 0;
  return {
    pass: ok,
    detail: ok
      ? "no audio started before a gesture"
      : `before gesture: ${early.join("; ") || "autoplay errors"} ${autoplayMsgs.slice(0, 2).join(" | ")}`,
    metrics: {
      "audio.startedBeforeGesture": early.length,
      "audio.autoplayErrors": autoplayErrors,
      "audio.probe.ctxAfterGesture": ctxAfter,
    },
  };
}

const engines = selectedEngines();
const server = await startServer();
const base = server.base;

for (const engine of engines) {
  const browser = await launchEngine(engine);
  const results = new Results("pwa", engine);
  const chromium = engine === "chromium";
  const opts = { browser, base };

  await results.case("pwa.manifest.ok", (s) => manifestCase(s, base), opts);
  for (const theme of ["light", "dark"]) {
    await results.case(
      `menu-standalone.${theme}`,
      (s) => standaloneCase(s, base, theme, chromium),
      { ...opts, info: !chromium },
    );
  }
  await results.case("audio.startedBeforeGesture", (s) => audioCase(s, base), opts);

  results.save();
  await browser.close().catch(() => undefined);
}

writeIndex();
await runCleanups();
