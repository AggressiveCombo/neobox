// Audit instrument (round 0 extra): inventory coverage and harvest, copy placeholders, design
// token spread, dead controls, and preference persistence (RUBRIC D13, D14, D18, D19).
//
// Keys:
//   coverage.inventory.missing   harvested control names not in INVENTORY + INVENTORY ids with no
//                                state or scenario (components in evidence/audit-<engine>/coverage.json)
//   copy.placeholderHits         regex hits in visible text and aria-labels, desktop + phone, all states
//   tokens.distinct.<fontSize|radius|padding|color>.<primary|secondary|danger|ghost|link>
//                                distinct computed values per role at rest, max over light and dark
//   tokens.distinct.fontSize.body  distinct font sizes of text elements across the sampled screens
//   deadControl.count            clicked controls with no visible change in 1 s (pixels, request, route, download, sound or focus), desktop + phone
//   persist.roundTrip            fraction of the DEFAULT_PREFS keys (read from src/prefs.ts) that survive a reload after
//                                being set through the settings UI
//   persist.accountSync          signed-in prefs (theme, textScale) pulled by a second context (info)
//
// Pass rules: coverage and copy pass at 0; tokens pass when every role/property has one value
// and body font sizes are <= 6; dead controls and controls only reachable behind a modal pass at 0;
// persist passes at 1.0.
//
// Run: cd client && QA_OUT=C:/Users/aggressivecombo/neobox-scratch/qa/round0-extra node qa/audit.mjs
//      QA_ENGINES=chromium limits engines; QA_ONLY=copy,tokens limits cases (keys: copy, coverage,
//      dead, tokens, persist, accountSync).
// Self-test: QA_SELF_TEST=<mode> injects a known defect into the measured path and runs only the
//   case for it; the verdict must be fail. Modes: placeholder (copy), inventory (coverage),
//   dead (dead controls: a control whose click only flips an attribute), tokens (stray button with its own radius/size), persist (wipes
//   neobox.prefs before reload). Use a separate QA_OUT so the baseline files are not overwritten.
// INVENTORY is read from QA_INVENTORY or the session local/INVENTORY.md.
// Output: <QA_OUT>/audit-<engine>.{json,md}; evidence under <QA_OUT>/evidence/audit-<engine>/.

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PNG } from "pngjs";
import { PASSWORD, Results, button, launchEngine, menuName, navTo, outDir, rel, runCleanups, selectedEngines, selfTestMode, sleep, startServer, writeIndex } from "./lib-qa.mjs";
import { signedIn } from "../e2e/lib.mjs";
import { scenarios } from "../e2e/scenarios.mjs";
import { STATES, stateById } from "./states.mjs";

const INVENTORY =
  process.env.QA_INVENTORY ??
  path.join(os.homedir(), ".omp/agent/sessions/-omp-workspace/2026-11-09T13-23-20-591Z_01a1c07a-438f-71e1-bf7d-0a843edfdf28/local/INVENTORY.md");
const PLACEHOLDER = /\b(undefined|null|NaN)\b|\[object |\{\{|\}\}|lorem|TODO|\b[a-z]+(\.[a-z]+){2,}\b|ECONN|TypeError|ReferenceError|\bat [\w.]+ \(/g;
// Every key of DEFAULT_PREFS, read from client/src/prefs.ts so a new pref cannot be left out. The denominator of persist.roundTrip.
const PREFS_SOURCE = readFileSync(fileURLToPath(new URL("../src/prefs.ts", import.meta.url)), "utf8");
const PREF_KEYS = [...(PREFS_SOURCE.match(/export const DEFAULT_PREFS: Prefs = \{([\s\S]*?)\n\};/)?.[1] ?? "").matchAll(/^  (\w+):/gm)].map((m) => m[1]);
if (PREF_KEYS.length === 0) throw new Error("audit: no DEFAULT_PREFS keys found in src/prefs.ts");
// Settings values set through the UI, and the stored value each one must read back as.
const EXPECT = {
  keys: ["KeyQ", "KeyA"], // left, slot 0 (compared as keys.left)
  volume: 0.3, muted: true, renderScale: 0.7, antialias: false, palette: "tritanopia", touchScale: 1.2, touchLeftHanded: true,
  touchLayout: { rocket: "grab", push: "push", jump: "up", bat: "bat", grab: "rocket" },
  showStats: true, color: 0x3366cc, musicMuted: true, matchMusicMuted: true, musicVolume: 0.3, sfxVolume: 0.4, uiSounds: false,
  filterProfanity: false, jukeboxVolume: 0.2, theme: "dark", motion: "reduce", textScale: 1.3, readableFont: true, captions: true,
};
// Controls that leave the harness's fixture (sign out, account delete, filing a report, moderation) are not clicked. Leave, remove, reset, delete and decline act on fixture state, which the scan re-prepares after any change.
const DEAD_SKIP = /\b(sign out|log out|delete account|report|kick|ban|forfeit|quit|block|unfriend|disband|revoke)\b/i;
// Names the harness generates as fixture data (room, player, password, map, roster rows): user content, not product controls.
const FIXTURE_NAME = /^(room|pw|host|guest|user)[a-z0-9]{6,8}(?![a-z])|^Actions for guest[a-z0-9]+|^map[a-z0-9]{5,9} by [a-z0-9]+ \d+ votes ?\d+ plays$/;
const DEAD_SCREENS = process.env.QA_DEAD_SCREENS ? process.env.QA_DEAD_SCREENS.split(",").map((s) => s.trim()) : selfTestMode() === "dead" ? [STATES[0].id] : STATES.map((st) => st.id);
const TOKEN_SCREENS = ["menu-anon", "settings-controls", "library-grid", "room-host"];
const TOKEN_THEMES = ["light", "dark"];
const ROLES = ["primary", "hero", "big", "secondary", "danger", "ghost", "link", "name", "icon", "clip", "ink", "block", "chrome", "tile", "seg", "tab"];
const PROPS = ["fontSize", "radius", "padding", "color"];
const MODE_CASE = { placeholder: "copy", inventory: "coverage", dead: "dead", tokens: "tokens", persist: "persist" };
const ONLY = (process.env.QA_ONLY ?? "copy,coverage,dead,tokens,persist,accountSync").split(",").map((s) => s.trim());
// Self-test injections (one per mode), applied to the page the mode measures.
const INJECT = {
  placeholder: { tag: "p", text: "Welcome to undefined", pos: "top:0;left:0" },
  inventory: { tag: "button", text: "Qa mystery control", pos: "top:0;left:0" },
  dead: { tag: "button", text: "Qa dead control", pos: "bottom:0;right:0", flip: true },
  tokens: { tag: "button", text: "Qa stray", pos: "top:0;right:0", css: "font-size:13px;border-radius:2px;padding:1px 2px" },
};

const inventoryText = readFileSync(INVENTORY, "utf8");
const inventoryLower = inventoryText.toLowerCase();
const inventoryIds = [
  ...new Set(
    inventoryText
      .split("\n")
      .filter((line) => line.startsWith("- ") && line.includes(" | "))
      .map((line) => line.slice(2).split("|")[0].trim()),
  ),
];
// An INVENTORY row is covered by a state of that id, a scenario of that name, or a scenario that lists it in `inv`.
const knownIds = new Set([...STATES.map((st) => st.id), ...scenarios.flatMap((sc) => [sc.name, ...(sc.inv ?? [])])]);
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const mentionsName = (name) => new RegExp(`(?<![a-z0-9])${escapeRe(name.toLowerCase())}(?![a-z0-9])`).test(inventoryLower);
const firstLine = (err) => String(err?.message ?? err).split("\n")[0];
const sameControls = (a, b) => a.length === b.length && a.every((c, i) => c.name === b[i].name);
const offSite = (href, base) => {
  try {
    return new URL(href).origin !== new URL(base).origin;
  } catch {
    return false; // not a URL: the control is clicked like any other
  }
};

// In-page probes. Each returns plain data; nothing here changes the page except the data-qa-i tags.
const HARVEST = () => {
  const vis = (el) => {
    const r = el.getBoundingClientRect();
    const cs = getComputedStyle(el);
    return r.width > 0 && r.height > 0 && cs.visibility !== "hidden" && cs.display !== "none";
  };
  const els = [...document.querySelectorAll("button, a[href], [role=button], [role=tab], [role=switch], [role=radio], [role=menuitem]")].filter(vis);
  // Accessible-name approximation: aria-label, then aria-labelledby, then <label> text (switches are inputs with no text),
  // then the element text with block children separated by a space (card heading + description), then title.
  const textOf = (node) =>
    [...node.childNodes]
      .map((n) => {
        if (n.nodeType === 3) return n.textContent;
        if (n.nodeType !== 1 || n.getAttribute("aria-hidden") === "true") return "";
        return getComputedStyle(n).display.startsWith("inline") ? textOf(n) : ` ${textOf(n)} `;
      })
      .join("");
  const labelled = (el) => (el.getAttribute("aria-labelledby") || "").split(/\s+/).filter(Boolean).map((id) => document.getElementById(id)?.textContent ?? "").join(" ");
  const labelOf = (el) => (el.labels ? [...el.labels].map((l) => textOf(l)).join(" ") : "");
  return els.map((el, i) => {
    el.setAttribute("data-qa-i", String(i));
    const name = (el.getAttribute("aria-label") || labelled(el) || labelOf(el) || textOf(el) || el.getAttribute("title") || "").replace(/\s+/g, " ").trim();
    const r = el.getBoundingClientRect();
    const top = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
    return {
      i,
      name: name || "(unnamed)",
      href: el.tagName === "A" ? el.href : null,
      disabled: el.disabled === true || el.getAttribute("aria-disabled") === "true",
      // The active tab, page or tool: clicking it changes nothing by design (editor tools mark the active one with aria-pressed).
      selected: el.getAttribute("aria-selected") === "true" || el.getAttribute("aria-checked") === "true" || el.getAttribute("aria-pressed") === "true" || (el.getAttribute("aria-current") ?? "false") !== "false",
      // Something else sits on the control's centre (an open modal): it cannot be clicked from here.
      covered: !!top && !el.contains(top) && !top.contains(el),
    };
  });
};
const VISIBLE_TEXT = () => {
  const parts = [document.body.innerText];
  for (const el of document.querySelectorAll("[aria-label]")) {
    const r = el.getBoundingClientRect();
    if (r.width > 0 && r.height > 0) parts.push(el.getAttribute("aria-label"));
  }
  return parts.join("\n");
};
const TOKENS = () => {
  const vis = (el) => {
    const r = el.getBoundingClientRect();
    const cs = getComputedStyle(el);
    return r.width > 0 && r.height > 0 && cs.visibility !== "hidden" && cs.display !== "none";
  };
  // The look a control is drawn as. One role is one intended look, so a role with two values on a screen is drift.
  const roleOf = (el) => {
    const c = el.classList;
    if (el.tagName === "A" || c.contains("home-privacy")) return "link"; // text link; home-privacy is an underlined text button, no padding
    if (c.contains("room-profile-link")) return "name"; // a player's name as a button: body text, no padding
    if (c.contains("big")) return c.contains("primary") ? "hero" : "big"; // 64px action at --step-lead; hero is the filled one
    if (c.contains("icon")) return "icon"; // square glyph button with an aria-label, no text
    if (c.contains("menu-clip-pause")) return "clip"; // 28 px icon button on the menu's clip backdrop: no padding, its own ink
    if (c.contains("seg-option")) return "seg"; // option of a segmented control, --control high
    if (c.contains("tab")) return "tab"; // tab of a tablist, --control high, underlined when selected
    if (c.contains("ink")) return "ink"; // solid ink fill
    if (c.contains("primary")) return "primary";
    if (c.contains("danger")) return "danger";
    if (c.contains("home-account")) return "chrome"; // account chip: 4px leading inset for the avatar, 14px text
    if (c.contains("quiet")) return "ghost";
    if (c.contains("block")) return "block"; // full-width plain button
    return "secondary";
  };
  const roles = [];
  for (const el of document.querySelectorAll("button:not([role]), button.seg-option, button.tab, a[href]")) {
    if (!vis(el)) continue;
    const cs = getComputedStyle(el);
    // Selected options differ by state (aria-checked / aria-selected), not by role: their colour stays out of the role set.
    const selected = el.matches('[aria-checked="true"], [aria-selected="true"]');
    roles.push({
      role: roleOf(el),
      fontSize: cs.fontSize,
      radius: cs.borderTopLeftRadius,
      padding: [cs.paddingTop, cs.paddingRight, cs.paddingBottom, cs.paddingLeft].join(" "),
      color: selected ? null : cs.color,
      // What the element is, for the evidence: its classes and text, so a value that drifts can be traced to its control.
      who: `${el.tagName.toLowerCase()}.${[...el.classList].join(".")} "${(el.textContent || el.getAttribute("aria-label") || "").trim().slice(0, 24)}"`,
    });
  }
  const body = [];
  for (const el of document.querySelectorAll("body *")) {
    if (!vis(el) || ![...el.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim())) continue;
    body.push(getComputedStyle(el).fontSize);
  }
  return { roles, body };
};
// Probes for the dead-control scan. A visible change is read from screenshots (frame, changedPixels); the page hooks record
// only what a screenshot cannot show: a sound request, a request the click causes, and the focus move a player sees.
const SOUND_HOOK = () => {
  if (window.__qaSoundHooked) return;
  window.__qaSoundHooked = true;
  window.__qaSound = 0;
  // The interface's own press feedback (a click, hover, switch or tab tick) plays on every button, so it is not what a control does.
  const PRESS_TICK = new Set(["click", "pointerover", "change"]);
  const count = () => {
    if (!PRESS_TICK.has(window.event?.type)) window.__qaSound += 1;
  };
  const play = HTMLMediaElement.prototype.play;
  HTMLMediaElement.prototype.play = function (...a) {
    count();
    return play.apply(this, a);
  };
  // OscillatorNode and AudioBufferSourceNode inherit start() from AudioScheduledSourceNode.
  const Source = window.AudioScheduledSourceNode;
  if (Source) {
    const start = Source.prototype.start;
    Source.prototype.start = function (...a) {
      count();
      return start.apply(this, a);
    };
  }
};
// The requests a click causes: a fetch, an XHR send, or a text WebSocket send made while that click's event dispatch
// runs, or in the promise jobs it queues. The flag ends with the dispatch (the window's bubble listener, the last one
// the event reaches), and a timer clears it as a backstop when a handler stops propagation. Timers, pings and binary
// input frames are never sent inside a click dispatch, so they never credit a click.
const NET_HOOK = () => {
  if (window.__qaNetHooked) return;
  window.__qaNetHooked = true;
  window.__qaNet = 0;
  let inClick = false;
  window.addEventListener("click", () => {
    inClick = true;
    setTimeout(() => {
      inClick = false;
    }, 0);
  }, true);
  window.addEventListener("click", () => {
    inClick = false;
  });
  const credit = () => {
    if (inClick) window.__qaNet += 1;
  };
  const fetchFn = window.fetch;
  window.fetch = function (...a) {
    credit();
    return fetchFn.apply(this, a);
  };
  const xhrSend = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.send = function (...a) {
    credit();
    return xhrSend.apply(this, a);
  };
  const wsSend = WebSocket.prototype.send;
  WebSocket.prototype.send = function (data) {
    if (typeof data === "string") credit();
    return wsSend.call(this, data);
  };
};
const ARM = () => {
  window.__qaFocus0 = document.activeElement;
  window.__qaSound = 0;
  window.__qaNet = 0;
};
const EFFECTS = () => {
  const a = document.activeElement;
  return {
    url: location.href,
    sound: window.__qaSound,
    net: window.__qaNet,
    focus: a !== window.__qaFocus0 && a !== document.body && a.matches(":focus-visible"),
  };
};
const PIXEL_DELTA = 24; // summed RGB difference that makes one pixel changed (the threshold motion.mjs pixelDelta uses)
const PIXEL_MIN = 40; // changed pixels that make a frame changed: anti-aliasing and a blinking caret stay below this
const IDLE_FRAMES = 4; // frames read at a state's open, IDLE_GAP_MS apart: pixels that move at rest are masked out
const IDLE_GAP_MS = 250;
const SAMPLE_MS = [340, 510, 680, 850, 1000]; // frames after a click, the last at 1 s; the first that shows an effect ends the wait
// Controls whose effect is invisible by design. Each rule names the reason it was reviewed; a matching dead verdict is
// listed as invisible, not counted as dead. Empty until a reviewed case needs one.
const INVISIBLE = [];

/** One viewport frame: the PNG bytes and the decoded pixels. The caret is hidden so a blinking cursor is not a change. */
async function frame(page) {
  const buf = await page.screenshot({ caret: "hide" });
  return { buf, img: PNG.sync.read(buf) };
}
const differs = (a, b, p) => {
  const i = p * 4;
  return Math.abs(a.data[i] - b.data[i]) + Math.abs(a.data[i + 1] - b.data[i + 1]) + Math.abs(a.data[i + 2] - b.data[i + 2]) > PIXEL_DELTA;
};
/** Pixels that changed between two frames, outside the mask. Frames of different sizes differ everywhere. */
function changedPixels(a, b, mask) {
  if (a.width !== b.width || a.height !== b.height) return Infinity;
  let n = 0;
  for (let p = 0; p < a.width * a.height; p++) if (!mask[p] && differs(a, b, p)) n++;
  return n;
}
/** Pixels that move while a screen idles (the menu arena, a spinner): every pixel that differs between two idle frames. */
function idleMask(frames) {
  const mask = new Uint8Array(frames[0].img.width * frames[0].img.height);
  for (let k = 1; k < frames.length; k++) {
    for (let p = 0; p < mask.length; p++) if (differs(frames[k - 1].img, frames[k].img, p)) mask[p] = 1;
  }
  return mask;
}
/** IDLE_FRAMES frames of a screen at rest, for idleMask. */
async function idleFrames(page) {
  const frames = [];
  for (let k = 0; k < IDLE_FRAMES; k++) {
    if (k > 0) await sleep(IDLE_GAP_MS);
    frames.push(await frame(page));
  }
  return frames;
}

/** The first gesture on a page unlocks audio (sound files load, the menu music starts), so a neutral key press does that before the scan reads a control. The menu's recorded clip moves in bursts no idle window can mask, so it is paused here (not counted, not clicked again): what moves on a frozen screen is the control's effect. */
async function warmUp(h) {
  await h.page.keyboard.press("ScrollLock");
  await requestsQuiet(h);
  const pause = h.page.getByRole("button", { name: "Pause clip" });
  // The clip bar shows once its list loads: a screen without one waits out the timeout and skips the pause.
  // A modal over the bar (menu-news) leaves it unclickable; the warm-up goes on without pausing.
  await pause.first().waitFor({ state: "visible", timeout: 3000 }).then(() => pause.first().click({ timeout: 3000 }).catch(() => undefined), () => undefined);
  await requestsQuiet(h);
}
/** Waits until no request has left the page for 800 ms (or 6 s at most). */
async function requestsQuiet(h) {
  let seen = -1;
  let quiet = 0;
  for (let t = 0; t < 30 && quiet < 4; t++) {
    await sleep(200);
    if (h.reqs === seen) quiet += 1;
    else {
      quiet = 0;
      seen = h.reqs;
    }
  }
}
const movingShare = (mask) => `${((mask.reduce((n, v) => n + v, 0) / mask.length) * 100).toFixed(1)}%`;
/** Two frames IDLE_GAP_MS apart show no change outside the idle mask: the screen is at rest, so a click's change is its own. */
async function atRest(page, mask) {
  const a = await frame(page);
  await sleep(IDLE_GAP_MS);
  return changedPixels(a.img, (await frame(page)).img, mask) < PIXEL_MIN;
}
/** Writes a dead control's screenshot into the evidence folder; returns its relative path. */
function writeShot(name, buf) {
  const file = path.join(outDir(), "evidence", `audit-${engine}`, "dead", `${name}.png`);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, buf);
  return rel(file);
}
/**
 * The same scenario with every prepare() on a phone viewport: the scan covers desktop and phone. The phone welcome is
 * skipped (its Play asks for fullscreen, and headless Firefox then resizes the window away from the phone viewport, so
 * clicks land on nothing). The welcome keeps its own coverage in e2e inv-match "phone splash".
 */
const phoneOf = (s) =>
  Object.assign(Object.create(s), {
    open: async (label, o = {}) => {
      const h = await s.open(label, { ...o, phone: true });
      await h.context.addInitScript(() => localStorage.setItem("neobox.phoneSplashSeen", "1"));
      return h;
    },
  });

let engine = "";
let memo = null;

function writeEvidence(name, obj) {
  const dir = path.join(outDir(), "evidence", `audit-${engine}`);
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${name}.json`);
  writeFileSync(file, `${JSON.stringify(obj, null, 2)}\n`);
  return file;
}

/** Injects the self-test defect for the running mode into the page (no-op outside self-test). */
async function inject(page) {
  const spec = INJECT[selfTestMode()];
  if (!spec) return;
  await page.evaluate(
    ({ tag, text, pos, css = "", flip = false }) => {
      const el = document.createElement(tag);
      el.textContent = text;
      el.style.cssText = `position:fixed;${pos};z-index:9999;background:#fff;color:#000;${css}`;
      // A click that only flips an attribute: a DOM change with nothing visible. The dead-control scan must count it dead.
      if (flip) el.addEventListener("click", () => document.documentElement.setAttribute("data-qa-flip", String(Date.now())));
      document.body.append(el);
    },
    spec,
  );
}

const track = (h) => {
  h.reqs = 0;
  h.page.on("request", () => {
    h.reqs += 1;
  });
  return h;
};
const closeHandle = (h) => h.context.close().catch(() => {});
/** Closes the contexts a state's prepare opened besides the one it returned (seeding accounts, the admin page). Left open, they pile up for the rest of the run and load the browser for every later state. */
async function closeSeeds(s, from, keep) {
  for (const h of s.handles.slice(from)) if (h !== keep) await h.context.close().catch(() => {});
}
/** A state's prepare, tried twice: a navigation the browser refuses (one root goto failed after 70 minutes) closes what the first try opened. */
async function prepareState(s, id, scope, from) {
  for (let attempt = 1; ; attempt++) {
    try {
      return await stateById(id).prepare(scope);
    } catch (err) {
      await closeSeeds(s, from, null);
      if (attempt >= 2) throw err;
    }
  }
}
const placeholderHits = (text) =>
  [...text.matchAll(PLACEHOLDER)].map((m) => text.slice(Math.max(0, m.index - 30), m.index + m[0].length + 30).replace(/\s+/g, " "));

/** Failed-request lines a network-down state causes (chromium, firefox, webkit wordings). */
const OFFLINE_ERR = /ERR_INTERNET_DISCONNECTED|NS_ERROR_OFFLINE|NetworkError when attempting|Failed to fetch|WebSocket connection to .* failed|can.t establish a connection|WebKit encountered an internal error/;

/**
 * States fail things on purpose and declare them (`h.expected` URL patterns, `h.expectedWarnings` text, as capture.mjs
 * isInduced). The Scenario does not filter them, so the audit drops them from each handle before a case is judged.
 * A state that took the network down (`h.offline`, set by states.mjs goOffline) owns the failed-request lines it causes.
 */
function pruneInduced(s) {
  for (const h of s.handles) {
    h.problems = h.problems.filter((p) => {
      if (h.offline && OFFLINE_ERR.test(p)) return false;
      const named = [p.match(/\((https?:\/\/[^()\s]*)\)$/)?.[1] ?? "", ...(p.match(/(?:https?|wss?):\/\/[^\s'")]+/g) ?? []).map((u) => u.replace(/[.,;:]+$/, ""))];
      const byUrl = named.some((u) => u !== "" && (h.expected ?? []).some((re) => re.test(u)));
      return !byUrl && !(h.expectedWarnings ?? []).some((re) => re.test(p));
    });
  }
}

/** Builds every state at desktop and phone size once per engine; shared by the coverage and copy cases. */
async function harvestAll(s) {
  if (memo) return memo;
  memo = { desktop: [], phone: [], errors: [] };
  const phoneScope = phoneOf(s);
  for (const st of STATES) {
    for (const [vp, scope] of [
      ["desktop", s],
      ["phone", phoneScope],
    ]) {
      const from = s.handles.length;
      let h = null;
      try {
        h = await st.prepare(scope);
        await inject(h.page);
        const controls = await h.page.evaluate(HARVEST);
        const hits = placeholderHits(await h.page.evaluate(VISIBLE_TEXT));
        memo[vp].push({ id: st.id, controls, hits });
      } catch (err) {
        memo.errors.push(`${vp}:${st.id}: ${firstLine(err)}`);
      } finally {
        if (h) await closeHandle(h);
        await closeSeeds(s, from, h);
      }
    }
  }
  pruneInduced(s);
  return memo;
}

async function copyCase(s) {
  const m = await harvestAll(s);
  const hits = [...m.desktop.map((sc) => ({ ...sc, vp: "desktop" })), ...m.phone.map((sc) => ({ ...sc, vp: "phone" }))].flatMap((sc) =>
    sc.hits.map((text) => ({ screen: sc.id, viewport: sc.vp, text })),
  );
  const file = writeEvidence("copy-placeholders", { hits, errors: m.errors });
  return {
    pass: hits.length === 0,
    detail: `${hits.length} placeholder hits across ${m.desktop.length + m.phone.length} screens; ${m.errors.length} screens failed to build`,
    metrics: { "copy.placeholderHits": hits.length },
    evidence: [rel(file)],
  };
}

async function coverageCase(s) {
  const m = await harvestAll(s);
  const screensOf = new Map();
  for (const sc of [...m.desktop, ...m.phone]) {
    for (const c of sc.controls) {
      if (FIXTURE_NAME.test(c.name)) continue;
      const list = screensOf.get(c.name) ?? [];
      if (!list.includes(sc.id)) list.push(sc.id);
      screensOf.set(c.name, list);
    }
  }
  // RUBRIC metric: harvested controls missing from INVENTORY. INVENTORY ids without a state or scenario are reported only.
  const missingControls = [...screensOf].filter(([name]) => !mentionsName(name)).map(([name, screens]) => ({ name, screens }));
  const uncoveredIds = inventoryIds.filter((id) => !knownIds.has(id));
  const value = missingControls.length;
  const file = writeEvidence("coverage", { missingControls, uncoveredIds, errors: m.errors });
  return {
    pass: value === 0,
    detail:
      `${missingControls.length} harvested controls not in INVENTORY (${missingControls.slice(0, 8).map((c) => c.name).join(", ")}); ` +
      `${uncoveredIds.length} of ${inventoryIds.length} INVENTORY ids have no state or scenario; ${m.errors.length} screens failed to build`,
    metrics: {
      "coverage.inventory.missing": value,
      "coverage.inventory.missingControls": missingControls.length,
      "coverage.inventory.uncoveredIds": uncoveredIds.length,
      "coverage.harvestedControls": screensOf.size,
    },
    evidence: [rel(file)],
  };
}

async function tokensCase(s) {
  const sets = {};
  const bodySizes = new Set();
  const counts = {};
  const examples = {}; // "prop.role=value" -> the first element that has the value
  for (const theme of TOKEN_THEMES) sets[theme] = {};
  for (const id of TOKEN_SCREENS) {
    const h = await stateById(id).prepare(s);
    try {
      for (const theme of TOKEN_THEMES) {
        // Account prefs pulled on load overwrite a forced theme (account.ts pullPrefs), so the theme is driven by the
        // system scheme ("system" resolves to it) and checked after the reload.
        await h.page.emulateMedia({ colorScheme: theme });
        await h.page.evaluate((t) => {
          const p = JSON.parse(localStorage.getItem("neobox.prefs") ?? "null") ?? {};
          localStorage.setItem("neobox.prefs", JSON.stringify({ ...p, theme: t }));
        }, "system");
        await h.page.reload();
        await sleep(800);
        const applied = await h.page.evaluate(() => document.documentElement.dataset.theme);
        if (applied !== theme) throw new Error(`tokens: ${id} rendered ${applied}, wanted ${theme}`);
        await inject(h.page);
        const { roles, body } = await h.page.evaluate(TOKENS);
        for (const r of roles) {
          counts[r.role] = (counts[r.role] ?? 0) + 1;
          for (const prop of PROPS) {
            if (r[prop] === null) continue; // a state's colour (selected tab/option), not a role's
            const key = `${prop}.${r.role}`;
            sets[theme][key] ??= new Set();
            sets[theme][key].add(r[prop]);
            examples[`${key}=${r[prop]}`] ??= r.who;
          }
        }
        for (const v of body) bodySizes.add(v);
      }
    } finally {
      await closeHandle(h);
    }
  }
  const metrics = {};
  const perTheme = {};
  for (const role of ROLES) {
    for (const prop of PROPS) {
      const key = `${prop}.${role}`;
      const counts = TOKEN_THEMES.map((t) => sets[t][key]?.size ?? 0);
      metrics[`tokens.distinct.${key}`] = Math.max(...counts);
      perTheme[key] = Object.fromEntries(TOKEN_THEMES.map((t, i) => [t, [...(sets[t][key] ?? [])], counts[i]]));
    }
  }
  metrics["tokens.distinct.fontSize.body"] = bodySizes.size;
  const file = writeEvidence("tokens", { perTheme: Object.fromEntries(Object.entries(perTheme).map(([k, v]) => [k, v])), body: [...bodySizes], roleSamples: counts, examples });
  const multi = ROLES.flatMap((role) => PROPS.map((prop) => `${prop}.${role}`)).filter((key) => metrics[`tokens.distinct.${key}`] > 1);
  const pass = multi.length === 0 && bodySizes.size <= 6;
  return {
    pass,
    detail: `${multi.length} role/property pairs with more than one value (${multi.join(", ") || "none"}); body font sizes ${bodySizes.size}`,
    metrics,
    evidence: [rel(file)],
  };
}

// Harvest once the screen has stopped changing (two consecutive reads agree): a screen can still be mid-transition when prepare() returns.
async function settledHarvest(page) {
  let fresh = await page.evaluate(HARVEST);
  for (let t = 0; t < 10; t++) {
    await sleep(150);
    const next = await page.evaluate(HARVEST);
    const same = next.length === fresh.length && next.every((f, j) => f.name === fresh[j].name);
    fresh = next;
    if (same) break;
  }
  return fresh;
}

async function deadCase(s) {
  const dead = [];
  const deadShots = []; // before and after frames of each dead control, as evidence files
  const skipped = [];
  const unclickable = [];
  const worked = []; // controls whose click produced an effect, with the kinds that showed it
  const external = []; // off-origin hrefs with a valid URL: a route effect, counted without a click
  const selectedNoop = []; // already-selected controls: activating one changed nothing and raised no error
  const invisible = []; // no effect, but listed in INVISIBLE with its reviewed reason
  const unreachable = []; // controls only ever covered by a modal
  const coveredElsewhere = []; // behind a modal in one state, uncovered in a no-modal state
  const reachable = new Set(); // "vp|name": a no-modal state shows the control uncovered
  const behindModal = []; // covered controls, resolved once every state of both viewports is scanned
  const stateFailed = []; // states that could not open: their controls are not scanned, so the verdict fails
  const idle = {}; // per "vp state": share of pixels that move at rest (masked out of every change)
  const phoneScope = phoneOf(s);
  let clicked = 0;
  for (const [vp, scope] of [
    ["desktop", s],
    ["phone", phoneScope],
  ]) {
    for (const id of DEAD_SCREENS) {
      let cur = null;
      const release = async () => {
        if (!cur) return;
        await closeHandle(cur.h);
        await closeSeeds(s, cur.from, cur.h);
      };
      const open = async () => {
        await release();
        const from = s.handles.length;
        const h = track(await prepareState(s, id, scope, from));
        await inject(h.page);
        await warmUp(h);
        const controls = await settledHarvest(h.page);
        // A state with no modal shows the base controls; only those count as reachable behind a modal.
        if (!stateById(id).dialog) for (const c of controls) if (!c.covered) reachable.add(`${vp}|${c.name}`);
        await h.page.evaluate(SOUND_HOOK);
        await h.page.evaluate(NET_HOOK);
        const st = { h, controls, dirty: false, from, errors: [], downloads: 0, popups: 0, idle: null };
        cur = st;
        // What a click can do that a frame does not show: an error, a download, a new window, a network request it causes.
        h.page.on("pageerror", (err) => st.errors.push(err.message));
        h.page.on("console", (msg) => {
          if (msg.type() === "error") st.errors.push(msg.text());
        });
        h.page.on("download", () => {
          st.downloads += 1;
        });
        h.page.context().on("page", () => {
          st.popups += 1;
        });
        st.idle = idleMask(await idleFrames(h.page));
        idle[`${vp} ${id}`] = movingShare(st.idle);
      };
      // A reopen that fails fails this state: the controls not yet clicked are not scanned, so the verdict fails on it.
      const reopen = async () => {
        try {
          await open();
          return true;
        } catch (err) {
          stateFailed.push(`${vp} ${id} (reopen): ${firstLine(err)}`);
          return false;
        }
      };
      try {
        await open();
      } catch (err) {
        // A state that cannot open is a failure of that state; the other states still scan, and the verdict fails on it.
        stateFailed.push(`${vp} ${id}: ${firstLine(err)}`);
        continue;
      }
      console.error(`dead ${vp} ${id}: ${cur.controls.length} controls, ${new Date().toISOString().slice(11, 19)}`);
      for (const c of cur.controls) {
        const label = `${vp} ${id} "${c.name}"`;
        if (c.disabled) {
          skipped.push(`${label} (disabled: not operable)`);
          continue;
        }
        if (FIXTURE_NAME.test(c.name)) {
          skipped.push(`${label} (fixture data: harness-generated name)`);
          continue;
        }
        if (DEAD_SKIP.test(c.name)) {
          skipped.push(`${label} (destructive: leaves the fixture)`);
          continue;
        }
        // An off-origin href with a valid URL navigates the app away: a route effect, counted without a click.
        if (c.href && offSite(c.href, s.base)) {
          external.push(label);
          worked.push(`${label}: route (external href ${new URL(c.href).origin}, not clicked)`);
          continue;
        }
        // Behind the state's modal: resolved after every state, once it is known whether a no-modal state shows the control.
        if (c.covered) {
          behindModal.push({ vp, label, name: c.name });
          continue;
        }
        if (cur.dirty || !(await atRest(cur.h.page, cur.idle))) {
          if (!(await reopen())) break;
          if (!cur.controls.some((f) => f.name === c.name)) {
            unclickable.push(`${label}: screen did not return to the same controls`);
            continue;
          }
        }
        // A re-render since the last click can drop a control without a navigation; reopen the state and look again before calling it unclickable.
        const hasControl = async () => (await cur.h.page.evaluate(HARVEST)).some((f) => f.name === c.name);
        if (!(await hasControl())) {
          if (!(await reopen())) break;
          if (!(await hasControl())) {
            const now = (await cur.h.page.evaluate(HARVEST)).map((f) => f.name);
            unclickable.push(`${label}: control "${c.name}" is no longer on screen after reopening the state [${now.length} on screen: ${now.slice(0, 4).join(" | ")}]`);
            continue;
          }
        }
        const st = cur;
        const h = st.h;
        const page = h.page;
        const url = page.url();
        // Scroll is reset first: a control that only scrolls to a section (settings nav) would read as dead when that section is already in view.
        // The reset moves the page, so the selection the control shows now (a nav's aria-current follows the scroll, a frame later) is read again.
        await page.evaluate(
          () =>
            new Promise((done) => {
              document.querySelectorAll("*").forEach((e) => { if (e.scrollTop) e.scrollTop = 0; if (e.scrollLeft) e.scrollLeft = 0; });
              requestAnimationFrame(() => done());
            }),
        );
        c.selected = (await page.evaluate(HARVEST)).find((f) => f.name === c.name)?.selected ?? c.selected;
        clicked += 1;
        let k = c.i;
        let base = null;
        let last = null;
        let kinds = [];
        let moving = false;
        try {
          // Re-find the control by name (a re-render since open() can move or drop data-qa-i). Hover, then the before frame, then the click; a click that cannot reach its element is retried on a fresh harvest, up to 3 tries.
          let t0 = 0;
          for (let attempt = 1; ; attempt++) {
            const fresh = await settledHarvest(page);
            k = fresh[c.i]?.name === c.name ? c.i : fresh.findIndex((f) => f.name === c.name);
            if (k < 0) throw new Error(`control "${c.name}" is no longer on screen`);
            const target = page.locator(`[data-qa-i="${k}"]`);
            try {
              // The pointer rests on the control first, so its hover style is in the before frame and not in the click's effect.
              await target.hover({ timeout: 3000 });
              await sleep(300);
              base = await frame(page);
              await page.evaluate(ARM);
              st.errors.length = 0;
              st.downloads = 0;
              st.popups = 0;
              t0 = Date.now();
              // A hold-type control (the phone ability buttons) acts while held: press it 400 ms so its effect shows in the sample window.
              const hold = await target.evaluate((el) => (el.classList.contains("hud-touch") ? 400 : 0));
              await target.click({ timeout: 3000, delay: hold });
              break;
            } catch (err) {
              if (attempt >= 3) throw err;
              await sleep(300);
            }
          }
          // Frames up to 1 s after the click; the first one that shows an effect ends the wait.
          let prev = null;
          for (const at of SAMPLE_MS) {
            await sleep(Math.max(0, t0 + at - Date.now()));
            const fx = await page.evaluate(EFFECTS);
            prev = last;
            last = await frame(page);
            // Still moving at the last sample: the screen is not settled, so the next control reopens it.
            moving = prev !== null && changedPixels(prev.img, last.img, st.idle) >= PIXEL_MIN;
            kinds = [
              changedPixels(base.img, last.img, st.idle) >= PIXEL_MIN && "pixels",
              fx.net > 0 && "request",
              (fx.url !== url || st.popups > 0) && "route",
              st.downloads > 0 && "download",
              fx.sound > 0 && "sound",
              fx.focus && "focus",
            ].filter(Boolean);
            if (kinds.length) break;
          }
          const moved = kinds.includes("route");
          if (c.selected && st.errors.length) {
            dead.push(`${label} (error on activation: ${st.errors[0]})`);
            st.dirty = true;
          } else if (kinds.length === 0) {
            if (c.selected) selectedNoop.push(label);
            else {
              const rule = INVISIBLE.find((r) => r.name.test(c.name));
              if (rule) invisible.push(`${label}: ${rule.reason}`);
              else {
                dead.push(label);
                const n = dead.length;
                deadShots.push({
                  label,
                  before: writeShot(`${vp}-${id}-${n}-before`, base.buf),
                  after: writeShot(`${vp}-${id}-${n}-after`, last.buf),
                });
              }
            }
          } else {
            worked.push(`${label}: ${kinds.join(", ")}`);
            // Reopen only when the click navigated, changed the control list, or is still animating; a toggle keeps the page (reopening after each one made the scan too slow).
            st.dirty = moving || moved || !sameControls(st.controls, await settledHarvest(page));
          }
        } catch (err) {
          // What sits on top of the control's centre point (a modal or overlay blocks the click; the harness should say so).
          const cover = await page
            .evaluate((i) => {
              const el = document.querySelector(`[data-qa-i="${i}"]`);
              if (!el) return "no element";
              const r = el.getBoundingClientRect();
              const top = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
              return top && top !== el && !el.contains(top) ? `covered by <${top.tagName.toLowerCase()} class="${top.className}">` : "not covered";
            }, k)
            .catch((e) => `cover probe failed: ${firstLine(e)}`);
          unclickable.push(`${label}: ${firstLine(err)} [${cover}]`);
          st.dirty = true;
        }
      }
      await release();
    }
  }
  pruneInduced(s);
  // A control under a modal is covered elsewhere when a state with no modal shows it uncovered; otherwise it is only reachable behind a modal.
  for (const b of behindModal) {
    if (reachable.has(`${b.vp}|${b.name}`)) coveredElsewhere.push(b.label);
    else unreachable.push(`${b.label}: only reachable behind a modal`);
  }
  const file = writeEvidence("dead-controls", { dead, deadShots, skipped, unclickable, unreachable, worked, selectedNoop, external, coveredElsewhere, invisible, idle });
  // Skip classes (the reason in each "(...)" suffix), so a skip count is never read without its reason.
  const byReason = {};
  for (const sk of skipped) {
    const reason = sk.slice(sk.lastIndexOf("(") + 1, -1);
    byReason[reason] = (byReason[reason] ?? 0) + 1;
  }
  const phoneDead = dead.filter((d) => d.startsWith("phone ")).length;
  return {
    pass: dead.length === 0 && unreachable.length === 0 && stateFailed.length === 0,
    detail: `${stateFailed.length} states failed to open (${stateFailed.slice(0, 3).join("; ") || "none"}); ${dead.length} dead controls of ${clicked} clicked (desktop ${dead.length - phoneDead}, phone ${phoneDead}; ${dead.slice(0, 10).join("; ") || "none"}); ${invisible.length} invisible by design (reviewed); ${selectedNoop.length} already selected, no-op; ${external.length} external links counted as route effects; ${coveredElsewhere.length} behind a modal and scanned uncovered in a no-modal state; ${unreachable.length} only reachable behind a modal; ${skipped.length} skipped (${Object.entries(byReason).map(([k, v]) => `${k} ${v}`).join(", ") || "none"}); ${unclickable.length} not clickable`,
    metrics: {
      "deadControl.count": dead.length,
      "deadControl.phone": phoneDead,
      "deadControl.clicked": clicked,
      "deadControl.skipped": skipped.length,
      "deadControl.unclickable": unclickable.length,
      "deadControl.worked": worked.length,
      "deadControl.invisible": invisible.length,
      "deadControl.selectedNoop": selectedNoop.length,
      "deadControl.external": external.length,
      "deadControl.coveredElsewhere": coveredElsewhere.length,
      "deadControl.onlyBehindModal": unreachable.length,
    },
    evidence: [rel(file)],
  };
}

const sec = (page, name) => page.locator(".settings-nav-item").filter({ hasText: name }).click();
const pick = (page, group, option) => page.getByRole("radiogroup", { name: group }).getByRole("radio", { name: option }).click();
const sw = (page, text) => page.locator("label.check").filter({ hasText: text }).click();
const range = (page, label, v) => page.getByLabel(label, { exact: true }).fill(String(v));
const storedPrefs = (page) => page.evaluate(() => localStorage.getItem("neobox.prefs")).then((raw) => JSON.parse(raw ?? "null"));

async function persistCase(s) {
  const h = await s.open("persist");
  const page = h.page;
  await page.goto(s.base);
  await menuName(page).waitFor();
  await navTo(page, "Settings");
  await sec(page, "Controls");
  await page.locator('[data-slot="left:0"]').click();
  await page.keyboard.press("KeyQ");
  await sleep(300);
  await sec(page, "Touch");
  await range(page, "Control size", 120);
  await sw(page, "Left-handed layout");
  await page.locator('select.touch-select[data-slot="rocket"]').selectOption("grab");
  await sec(page, "Sound");
  await range(page, "Volume", 30);
  await range(page, "Music volume", 30);
  await range(page, "Effects volume", 40);
  await range(page, "Jukebox volume", 20);
  await sw(page, "Mute all sound");
  await sw(page, "Mute menu music");
  await sw(page, "Mute match music");
  await sw(page, "Interface sounds");
  await sec(page, "Display");
  await pick(page, "Theme", "Dark");
  await range(page, "Render scale", 70);
  await sw(page, "Anti-aliasing");
  await sw(page, "Show stats");
  await page.locator('input[name="palette"][value="tritanopia"]').check({ force: true });
  await page.getByRole("button", { name: "Choose colour" }).click();
  await page.locator(".color-custom").fill("#3366cc");
  await page.getByRole("button", { name: "Save colour" }).click();
  await sec(page, "Accessibility");
  await pick(page, "Motion", "Reduce");
  await pick(page, "Text size", "130%");
  await sw(page, "Readable font");
  await sw(page, "Sound captions");
  await sec(page, "Chat");
  await sw(page, "Filter profanity");
  await sleep(300);
  if (selfTestMode() === "persist") await page.evaluate(() => localStorage.removeItem("neobox.prefs"));
  await page.reload();
  await menuName(page).waitFor();
  const stored = (await storedPrefs(page)) ?? {};
  const same = (a, b) => (typeof a === "number" && typeof b === "number" ? Math.abs(a - b) < 1e-9 : JSON.stringify(a) === JSON.stringify(b));
  const survived = [];
  const lost = [];
  for (const key of PREF_KEYS) {
    const want = key === "keys" ? EXPECT.keys : EXPECT[key];
    const got = key === "keys" ? stored.keys?.left : stored[key];
    const ok = want !== undefined && same(got, want);
    (ok ? survived : lost).push(ok ? key : `${key} (stored ${JSON.stringify(got)}, want ${JSON.stringify(want)})`);
  }
  const file = writeEvidence("persist", { survived, lost });
  const ratio = survived.length / PREF_KEYS.length;
  return {
    pass: survived.length === PREF_KEYS.length,
    detail: `${survived.length}/${PREF_KEYS.length} keys survive reload${lost.length ? `; lost: ${lost.join("; ")}` : ""}`,
    metrics: { "persist.roundTrip": ratio, "persist.keysSurvived": survived.length },
    evidence: [rel(file)],
  };
}

async function accountCase(s) {
  const a = await signedIn(s, "syncA");
  await navTo(a.page, "Settings");
  await sec(a.page, "Display");
  await pick(a.page, "Theme", "Dark");
  await sec(a.page, "Accessibility");
  const saved = a.page.waitForResponse((r) => r.url().endsWith("/api/account/prefs") && r.request().method() === "PUT", { timeout: 10000 });
  await pick(a.page, "Text size", "130%");
  await saved.catch(() => undefined);
  const b = await s.open("syncB");
  await b.page.goto(s.base);
  await menuName(b.page).waitFor();
  await b.page.getByRole("button", { name: /^(Sign in|Account, Level \d+)$/ }).first().click();
  await b.page.locator(".account-form").getByLabel("name", { exact: true }).fill(a.userName);
  await b.page.getByLabel("password", { exact: true }).fill(PASSWORD);
  await button(b.page, "Sign in").click();
  await b.page.getByText("Signed in.").waitFor();
  const deadline = Date.now() + 10000;
  let stored = {};
  while (Date.now() < deadline) {
    stored = (await storedPrefs(b.page)) ?? {};
    if (stored.theme === "dark" && stored.textScale === 1.3) break;
    await sleep(300);
  }
  const synced = [stored.theme === "dark", stored.textScale === 1.3].filter(Boolean).length;
  return {
    pass: synced === 2,
    detail: `second context shows theme=${stored.theme}, textScale=${stored.textScale} after sign-in (want dark, 1.3)`,
    metrics: { "persist.accountSync": synced / 2 },
  };
}

const engines = selectedEngines();
const server = await startServer();
const base = server.base;
const mode = selfTestMode();
const wanted = (key) => ONLY.includes(key) && (!mode || MODE_CASE[mode] === key);

/** Whole-case budget like robust.mjs: a hung case fails as 'timeout' instead of idling the run. The dead-control walk of every screen and viewport can run for hours; QA_CASE_TIMEOUT_MS sets it for a full run. */
const CASE_TIMEOUT_MS = Number(process.env.QA_CASE_TIMEOUT_MS) || 3600000;
function caseBudgeted(results, id, fn, opts) {
  return results.case(
    id,
    (s) => {
      let timer;
      const limit = new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`timeout: no result after ${CASE_TIMEOUT_MS / 1000}s`)), CASE_TIMEOUT_MS);
      });
      return Promise.race([Promise.resolve(fn(s)), limit]).finally(() => clearTimeout(timer));
    },
    opts,
  );
}

for (const eng of engines) {
  engine = eng;
  memo = null;
  const browser = await launchEngine(eng);
  const results = new Results("audit", eng);
  const opts = { browser, base };
  if (wanted("copy")) await caseBudgeted(results, "copy.placeholderHits", copyCase, opts);
  if (wanted("coverage")) await caseBudgeted(results, "coverage.inventory.missing", coverageCase, opts);
  if (wanted("tokens")) await caseBudgeted(results, "tokens.distinct", tokensCase, opts);
  if (wanted("dead")) await caseBudgeted(results, "deadControl.count", deadCase, opts);
  if (wanted("persist")) await caseBudgeted(results, "persist.roundTrip", persistCase, opts);
  if (wanted("accountSync")) await caseBudgeted(results, "persist.accountSync", accountCase, opts);
  results.save();
  await browser.close().catch(() => undefined);
}

writeIndex();
await runCleanups();
