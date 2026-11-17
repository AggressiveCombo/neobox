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
//   deadControl.count            visible controls that change nothing (no DOM, request or route) in 1 s
//   persist.roundTrip            fraction of the DEFAULT_PREFS keys (read from src/prefs.ts) that survive a reload after
//                                being set through the settings UI
//   persist.accountSync          signed-in prefs (theme, textScale) pulled by a second context (info)
//
// Pass rules: coverage and copy pass at 0; tokens pass when every role/property has one value
// and body font sizes are <= 6; dead controls pass at 0; persist passes at 1.0.
//
// Run: cd client && QA_OUT=C:/Users/aggressivecombo/neobox-scratch/qa/round0-extra node qa/audit.mjs
//      QA_ENGINES=chromium limits engines; QA_ONLY=copy,tokens limits cases (keys: copy, coverage,
//      dead, tokens, persist, accountSync).
// Self-test: QA_SELF_TEST=<mode> injects a known defect into the measured path and runs only the
//   case for it; the verdict must be fail. Modes: placeholder (copy), inventory (coverage),
//   dead (dead controls), tokens (stray button with its own radius/size), persist (wipes
//   neobox.prefs before reload). Use a separate QA_OUT so the baseline files are not overwritten.
// INVENTORY is read from QA_INVENTORY or the session local/INVENTORY.md.
// Output: <QA_OUT>/audit-<engine>.{json,md}; evidence under <QA_OUT>/evidence/audit-<engine>/.

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
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
  filterProfanity: false, jukeboxVolume: 0.2, theme: "dark", motion: "reduce", textScale: 1.3, readableFont: true,
};
// Destructive or irreversible controls are not clicked by the dead-control scan.
const DEAD_SKIP = /\b(leave|delete|reset|sign out|log out|remove|kick|ban|forfeit|quit|report|block|unfriend|disband|decline|reject|abandon|revoke)\b/i;
// Names the harness generates as fixture data (room, player, password, map, roster rows): user content, not product controls.
const FIXTURE_NAME = /^(room|pw|host|guest|user)[a-z0-9]{6,8}(?![a-z])|^Actions for guest[a-z0-9]+|^map[a-z0-9]{5,9} by [a-z0-9]+ \d+ votes ?\d+ plays$/;
const DEAD_SCREENS = process.env.QA_DEAD_SCREENS ? process.env.QA_DEAD_SCREENS.split(",").map((s) => s.trim()) : STATES.map((st) => st.id);
const TOKEN_SCREENS = ["menu-anon", "settings-controls", "library-grid", "room-host"];
const TOKEN_THEMES = ["light", "dark"];
const ROLES = ["primary", "secondary", "danger", "ghost", "link"];
const PROPS = ["fontSize", "radius", "padding", "color"];
const MODE_CASE = { placeholder: "copy", inventory: "coverage", dead: "dead", tokens: "tokens", persist: "persist" };
const ONLY = (process.env.QA_ONLY ?? "copy,coverage,dead,tokens,persist,accountSync").split(",").map((s) => s.trim());
// Self-test injections (one per mode), applied to the page the mode measures.
const INJECT = {
  placeholder: { tag: "p", text: "Welcome to undefined", pos: "top:0;left:0" },
  inventory: { tag: "button", text: "Qa mystery control", pos: "top:0;left:0" },
  dead: { tag: "button", text: "Qa dead control", pos: "bottom:0;right:0" },
  tokens: { tag: "button", text: "Qa stray", pos: "top:0;right:0", css: "font-size:13px;border-radius:2px;padding:1px 2px" },
};

const inventoryText = readFileSync(INVENTORY, "utf8");
const inventoryLower = inventoryText.toLowerCase();
const inventoryIds = inventoryText
  .split("\n")
  .filter((line) => line.startsWith("- ") && line.includes(" | "))
  .map((line) => line.slice(2).split("|")[0].trim());
const knownIds = new Set([...STATES.map((st) => st.id), ...scenarios.map((sc) => sc.name)]);
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const mentionsName = (name) => new RegExp(`(?<![a-z0-9])${escapeRe(name.toLowerCase())}(?![a-z0-9])`).test(inventoryLower);
const firstLine = (err) => String(err?.message ?? err).split("\n")[0];
const sameControls = (a, b) => a.length === b.length && a.every((c, i) => c.name === b[i].name);

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
      // The active tab or current page: clicking it changes nothing by design.
      selected: el.getAttribute("aria-selected") === "true" || (el.getAttribute("aria-current") ?? "false") !== "false",
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
  const roles = [];
  for (const el of document.querySelectorAll("button:not([role]), a[href]")) {
    if (!vis(el)) continue;
    const cs = getComputedStyle(el);
    const role = el.tagName === "A" ? "link" : el.classList.contains("primary") ? "primary" : el.classList.contains("danger") ? "danger" : el.classList.contains("quiet") ? "ghost" : "secondary";
    roles.push({
      role,
      fontSize: cs.fontSize,
      radius: cs.borderTopLeftRadius,
      padding: [cs.paddingTop, cs.paddingRight, cs.paddingBottom, cs.paddingLeft].join(" "),
      color: cs.color,
    });
  }
  const body = [];
  for (const el of document.querySelectorAll("body *")) {
    if (!vis(el) || ![...el.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim())) continue;
    body.push(getComputedStyle(el).fontSize);
  }
  return { roles, body };
};
const INSTALL_MUTATION = () => {
  window.__qaMut = 0;
  new MutationObserver((records) => {
    window.__qaMut += records.length;
  }).observe(document.body, { subtree: true, childList: true, attributes: true, characterData: true });
};
// Visible state beyond the DOM: scroll offsets (a nav link that scrolls a section is a working control) and a 64x64 pixel
// digest of each canvas (the map editor draws its view on canvas; zoom changes no DOM).
const EFFECT_STATE = () => {
  const scrolls = [...document.querySelectorAll("*")].filter((e) => e.scrollTop || e.scrollLeft).map((e) => `${e.scrollTop},${e.scrollLeft}`);
  const digest = (c) => {
    if (c.width === 0 || c.height === 0) return "";
    const t = document.createElement("canvas");
    t.width = 64;
    t.height = 64;
    const ctx = t.getContext("2d", { willReadFrequently: true });
    ctx.drawImage(c, 0, 0, 64, 64);
    let s = 0;
    for (const v of ctx.getImageData(0, 0, 64, 64).data) s = (s * 31 + v) | 0;
    return String(s);
  };
  const fields = [...document.querySelectorAll("input,select,textarea")].map((e) => (e.type === "checkbox" || e.type === "radio" ? `${e.checked}` : e.value));
  return JSON.stringify([window.scrollX, window.scrollY, scrolls, fields, [...document.querySelectorAll("canvas")].map(digest)]);
};

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
    ({ tag, text, pos, css = "" }) => {
      const el = document.createElement(tag);
      el.textContent = text;
      el.style.cssText = `position:fixed;${pos};z-index:9999;background:#fff;color:#000;${css}`;
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
  const phoneScope = Object.assign(Object.create(s), { open: (label, o = {}) => s.open(label, { ...o, phone: true }) });
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
  for (const theme of TOKEN_THEMES) sets[theme] = {};
  for (const id of TOKEN_SCREENS) {
    const h = await stateById(id).prepare(s);
    try {
      for (const theme of TOKEN_THEMES) {
        await h.page.evaluate((t) => {
          const p = JSON.parse(localStorage.getItem("neobox.prefs") ?? "null") ?? {};
          localStorage.setItem("neobox.prefs", JSON.stringify({ ...p, theme: t }));
        }, theme);
        await h.page.reload();
        await sleep(800);
        await inject(h.page);
        const { roles, body } = await h.page.evaluate(TOKENS);
        for (const r of roles) {
          counts[r.role] = (counts[r.role] ?? 0) + 1;
          for (const prop of PROPS) {
            const key = `${prop}.${r.role}`;
            sets[theme][key] ??= new Set();
            sets[theme][key].add(r[prop]);
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
  const file = writeEvidence("tokens", { perTheme: Object.fromEntries(Object.entries(perTheme).map(([k, v]) => [k, v])), body: [...bodySizes], roleSamples: counts });
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
  const skipped = [];
  const unclickable = [];
  const worked = []; // controls whose click produced an effect, with the effect kinds (the per-control verification)
  let clicked = 0;
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
      const h = track(await stateById(id).prepare(s));
      await inject(h.page);
      const controls = await settledHarvest(h.page);
      await h.page.evaluate(INSTALL_MUTATION);
      cur = { h, controls, dirty: false, from };
    };
    await open();
    console.error(`dead ${id}: ${cur.controls.length} controls, ${new Date().toISOString().slice(11, 19)}`);
    for (const c of cur.controls) {
      const label = `${id} "${c.name}"`;
      if (c.disabled) {
        skipped.push(`${label} (disabled)`);
        continue;
      }
      if (FIXTURE_NAME.test(c.name)) {
        skipped.push(`${label} (fixture data)`);
        continue;
      }
      if (c.selected) {
        skipped.push(`${label} (already selected)`);
        continue;
      }
      if (DEAD_SKIP.test(c.name)) {
        skipped.push(`${label} (destructive)`);
        continue;
      }
      if (c.href && new URL(c.href).origin !== new URL(s.base).origin) {
        skipped.push(`${label} (external link)`);
        continue;
      }
      // Behind the state's modal: the screen's own controls are scanned in its base state, and closing the modal here would drop the picker's own controls.
      if (c.covered) {
        skipped.push(`${label} (behind modal)`);
        continue;
      }
      if (cur.dirty) {
        await open();
        if (!cur.controls.some((f) => f.name === c.name)) {
          unclickable.push(`${label}: screen did not return to the same controls`);
          continue;
        }
      }
      // A re-render since the last click can drop a control without a navigation; reopen the state and look again before calling it unclickable.
      const hasControl = async () => (await cur.h.page.evaluate(HARVEST)).some((f) => f.name === c.name);
      if (!(await hasControl())) {
        await open();
        if (!(await hasControl())) {
          const now = (await cur.h.page.evaluate(HARVEST)).map((f) => f.name);
          unclickable.push(`${label}: control "${c.name}" is no longer on screen after reopening the state [${now.length} on screen: ${now.slice(0, 4).join(" | ")}]`);
          continue;
        }
      }
      const h = cur.h;
      const page = h.page;
      const url = page.url();
      // Scroll is reset first: a control that only scrolls to a section (settings nav) would read as dead when that section is already in view.
      await page.evaluate(() => document.querySelectorAll("*").forEach((e) => { if (e.scrollTop) e.scrollTop = 0; if (e.scrollLeft) e.scrollLeft = 0; }));
      const before = await page.evaluate(EFFECT_STATE);
      h.reqs = 0;
      clicked += 1;
      let k = c.i;
      try {
        // Re-tag and re-find the control by name: a re-render since open() can move or drop data-qa-i. A click that
        // cannot reach its tagged element (a re-render replaced it) is retried on a fresh harvest, up to 3 tries.
        for (let attempt = 1; ; attempt++) {
          const fresh = await settledHarvest(page);
          await page.evaluate(() => {
            window.__qaMut = 0; // the re-tag itself is a DOM mutation; it is not the click's effect
          });
          k = fresh[c.i]?.name === c.name ? c.i : fresh.findIndex((f) => f.name === c.name);
          if (k < 0) throw new Error(`control "${c.name}" is no longer on screen`);
          try {
            await page.locator(`[data-qa-i="${k}"]`).click({ timeout: 3000 });
            break;
          } catch (err) {
            if (attempt >= 3) throw err;
            await sleep(300);
          }
        }
        // Up to 1 s for any effect (DOM mutation, request, navigation, state change); stop early once one shows.
        let mut = 0;
        let moved = false;
        let changed = false;
        for (let t = 0; t < 10 && !(mut || h.reqs || moved || changed); t++) {
          await sleep(100);
          mut = await page.evaluate(() => window.__qaMut);
          moved = page.url() !== url;
          changed = (await page.evaluate(EFFECT_STATE)) !== before;
        }
        if (mut === 0 && h.reqs === 0 && !moved && !changed) dead.push(label);
        // Reopen only when the click navigated or changed the control list; a toggle keeps the page (reopening after each one made the scan too slow).
        else {
          worked.push(`${label}: ${[mut && "DOM", h.reqs && "request", moved && "route", changed && "state"].filter(Boolean).join(", ")}`);
          cur.dirty = moved || !sameControls(cur.controls, await settledHarvest(page));
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
        cur.dirty = true;
      }
    }
    await release();
  }
  pruneInduced(s);
  const file = writeEvidence("dead-controls", { dead, skipped, unclickable, worked });
  return {
    pass: dead.length === 0,
    detail: `${dead.length} dead controls of ${clicked} clicked (${dead.slice(0, 10).join("; ") || "none"}); ${skipped.length} skipped; ${unclickable.length} not clickable`,
    metrics: {
      "deadControl.count": dead.length,
      "deadControl.clicked": clicked,
      "deadControl.skipped": skipped.length,
      "deadControl.unclickable": unclickable.length,
      "deadControl.worked": worked.length,
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

/** Whole-case budget like robust.mjs: a hung case fails as 'timeout' instead of idling the run. Audit walks every screen, so the budget is generous. */
const CASE_TIMEOUT_MS = 3600000;
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
