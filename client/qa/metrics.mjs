// DOM metrics for one page state. `domMeasure` runs inside the page (page.evaluate serialises
// it, so it must stay self-contained). The rest are Node-side helpers that drive the page:
// reduced motion, axe-core, frame sampling, load timing and heap soak.

import { readFile } from "node:fs/promises";
import path from "node:path";
import { CLIENT_DIR } from "../e2e/lib.mjs";

export const AXE_PATH = path.join(CLIENT_DIR, "node_modules", "axe-core", "axe.min.js");

/**
 * Layout, overflow, edges, overlap, obscuring, targets, SR names and balance.
 * Returns { metrics, details, texts, controls, info }; `texts` and `controls` feed image.mjs.
 */
export function domMeasure(opts) {
  const W = innerWidth;
  const H = innerHeight;
  const doc = document.documentElement;
  const minTarget = opts.profile === "touch" ? 44 : 24;
  const details = {};
  const note = (key, value) => {
    const list = (details[key] ??= []);
    if (list.length < 60) list.push(value);
  };
  const cs = (el) => getComputedStyle(el);
  const describe = (el) => {
    const cls = typeof el.className === "string" && el.className.trim() ? `.${el.className.trim().split(/\s+/).slice(0, 2).join(".")}` : "";
    const id = el.id ? `#${el.id}` : "";
    const text = (el.textContent ?? "").trim().replace(/\s+/g, " ").slice(0, 40);
    return `${el.tagName.toLowerCase()}${id}${cls} "${text}"`;
  };
  const ancestorMatch = (el, pred) => {
    for (let a = el; a; a = a.parentElement) if (pred(a)) return a;
    return null;
  };
  const isFixed = (el) => ancestorMatch(el, (a) => cs(a).position === "fixed");
  const effectiveOpacity = (el) => {
    let o = 1;
    for (let a = el; a && a !== document.documentElement; a = a.parentElement) o *= parseFloat(cs(a).opacity);
    return o;
  };
  const visible = (el) => {
    const r = el.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) return false;
    const s = cs(el);
    if (s.display === "none" || s.visibility === "hidden" || s.visibility === "collapse") return false;
    // content of a closed <details> keeps its layout box but is not rendered
    const closed = el.closest("details:not([open])");
    if (closed && closed !== el && !el.closest("summary")) return false;
    if (el.checkVisibility && !el.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true })) return false;
    return effectiveOpacity(el) > 0.01;
  };
  // The toast host (#toasts, pointer-events none, transient) is an expected overlay: no overlap pair counts it.
  const toast = (el) => el.closest("#toasts") !== null;
  const clippedByAncestor = (el) =>
    ancestorMatch(el.parentElement, (a) => {
      if (a === document.body || a === document.documentElement) return false;
      const s = cs(a);
      return /hidden|auto|scroll|clip/.test(s.overflowX) || /hidden|auto|scroll|clip/.test(s.overflowY);
    }) !== null;
  const hasDirectText = (el) => [...el.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim() !== "");
  const bleed = (el) => el.closest("[data-qa-bleed]") !== null;

  const INTERACTIVE =
    'a[href],button,input:not([type=hidden]),select,textarea,summary,[role=button],[role=link],[role=checkbox],[role=radio],[role=tab],[role=menuitem],[role=option],[role=switch],[role=slider],[role=combobox],[role=textbox],[contenteditable=true],[tabindex]:not([tabindex="-1"])';

  // A modal (dialog) limits the measured content to itself; the page behind it is covered by design.
  const dialogs = [...document.querySelectorAll('[role=dialog],[role=alertdialog],dialog[open]')].filter(
    (d) => visible(d) && !d.classList.contains("phone-splash"),
  );
  const modal = dialogs[dialogs.length - 1] ?? null;
  const inScope = (el) => !modal || modal.contains(el);

  const all = [...document.querySelectorAll("body *")];
  const interactive = [...document.querySelectorAll(INTERACTIVE)].filter(
    (el) =>
      inScope(el) &&
      visible(el) &&
      !el.disabled &&
      el.getAttribute("aria-disabled") !== "true" &&
      !el.closest("[inert]") &&
      !bleed(el) &&
      !el.closest("script,style,noscript"),
  );
  const textLeaves = all.filter(
    (el) =>
      hasDirectText(el) &&
      inScope(el) &&
      visible(el) &&
      !bleed(el) &&
      !el.closest("script,style,noscript,[inert]"),
  );
  const content = [...new Set([...interactive, ...textLeaves])];

  // overflow.docX / docY
  const docW = Math.max(doc.scrollWidth, document.body ? document.body.scrollWidth : 0);
  const docX = Math.max(0, docW - W);
  const docScrollH = doc.scrollHeight;
  const docY = opts.fit && docScrollH - H > 1 ? 1 : 0;
  if (docY) note("overflow.docY_unexpected", `document ${docScrollH}px tall in ${H}px viewport`);

  // overflow.offscreen (clipped-by-design containers are scrolled, not offscreen)
  let offscreen = 0;
  for (const el of content) {
    if (clippedByAncestor(el)) continue;
    const r = el.getBoundingClientRect();
    const fixed = isFixed(el) !== null;
    const bad = r.left < -1 || r.right > W + 1 || (fixed && (r.top < -1 || r.bottom > H + 1));
    if (bad) {
      offscreen++;
      note("overflow.offscreen", `${describe(el)} at ${Math.round(r.left)},${Math.round(r.top)} ${Math.round(r.width)}x${Math.round(r.height)}`);
    }
  }

  // The element that scrolls the page: the nearest ancestor with an overflow-y scroll that overflows; else the document.
  const scrollerOf = (el) => {
    for (let a = el.parentElement; a; a = a.parentElement) {
      if (/auto|scroll/.test(cs(a).overflowY) && a.scrollHeight > a.clientHeight + 1) return a;
    }
    return doc;
  };
  // The part of a box the reader sees: clipped to the viewport and to each ancestor that clips its overflow on that
  // axis (clipping is at the padding box). Null when under 2px on either side. stripL/stripR: the clip on that side
  // is a horizontal scroll strip, so the box continues past it and that side is not a page edge.
  const shownRect = (r, el) => {
    let l = Math.max(r.left, 0);
    let t = Math.max(r.top, 0);
    let rt = Math.min(r.right, W);
    let b = Math.min(r.bottom, H);
    let stripL = false;
    let stripR = false;
    for (let a = el.parentElement; a && a !== document.body && a !== doc; a = a.parentElement) {
      const s = cs(a);
      if (s.display === "inline") continue;
      const clipX = /hidden|auto|scroll|clip/.test(s.overflowX);
      const clipY = /hidden|auto|scroll|clip/.test(s.overflowY);
      if (!clipX && !clipY) continue;
      const ar = a.getBoundingClientRect();
      const pl = ar.left + a.clientLeft;
      const pt = ar.top + a.clientTop;
      const strip = /auto|scroll/.test(s.overflowX) && a.scrollWidth > a.clientWidth + 1;
      if (clipX) {
        if (pl > l) {
          l = pl;
          stripL = strip;
        }
        if (pl + a.clientWidth < rt) {
          rt = pl + a.clientWidth;
          stripR = strip;
        }
      }
      if (clipY) {
        t = Math.max(t, pt);
        b = Math.min(b, pt + a.clientHeight);
      }
    }
    return rt - l >= 2 && b - t >= 2 ? { l, t, r: rt, b, stripL, stripR } : null;
  };
  // The glyph boxes of an element's own text (its line boxes): padding is not text, so it is not measured. A
  // pseudo-localised node's filler (capture.mjs pseudoLocalise) is not the app's text: only the original characters count.
  const textRects = (el) => {
    const range = document.createRange();
    const out = [];
    for (const n of el.childNodes) {
      if (n.nodeType !== 3 || n.textContent.trim() === "") continue;
      range.setStart(n, 0);
      range.setEnd(n, window.__plOriginal?.get(n) ?? n.textContent.length);
      out.push(...range.getClientRects());
    }
    return out;
  };
  // The shown parts of what an element paints: an inline element's fragments (a wrapped link is one per line), a
  // text leaf's glyph boxes trimmed to the font's em box (a line box is taller than its ink) and to the element's own
  // padding box when it clips (an ellipsis leaf's overflowing glyphs are not painted), else its border box.
  // Cached: every caller runs before the scroll passes below change the layout.
  const interactiveSet = new Set(interactive);
  const ownClip = (el) => {
    const s = cs(el);
    const clipX = /hidden|auto|scroll|clip/.test(s.overflowX);
    const clipY = /hidden|auto|scroll|clip/.test(s.overflowY);
    if (!clipX && !clipY) return null;
    const ar = el.getBoundingClientRect();
    const l = ar.left + el.clientLeft;
    const t = ar.top + el.clientTop;
    return { clipX, clipY, l, t, r: l + el.clientWidth, b: t + el.clientHeight };
  };
  const paintCache = new Map();
  const paint = (el) => {
    if (!paintCache.has(el)) {
      let raw;
      if (cs(el).display === "inline") {
        raw = [...el.getClientRects()];
      } else if (hasDirectText(el) && !interactiveSet.has(el)) {
        const fontPx = parseFloat(cs(el).fontSize);
        const clip = ownClip(el);
        raw = textRects(el).map((g) => {
          const pad = Math.max(0, (g.height - fontPx) / 2);
          let l = g.left;
          let r = g.right;
          let t = g.top + pad;
          let b = g.bottom - pad;
          if (clip?.clipX) {
            l = Math.max(l, clip.l);
            r = Math.min(r, clip.r);
          }
          if (clip?.clipY) {
            t = Math.max(t, clip.t);
            b = Math.min(b, clip.b);
          }
          return { left: l, right: r, top: t, bottom: b };
        });
      } else {
        raw = [el.getBoundingClientRect()];
      }
      paintCache.set(el, raw.map((r) => shownRect(r, el)).filter(Boolean));
    }
    return paintCache.get(el);
  };
  // Opaque painted background (not transparent, not partly transparent).
  const opaque = (e) => {
    const bg = cs(e).backgroundColor;
    if (bg === "" || bg === "transparent") return false;
    const m = bg.match(/^rgba\((.*)\)$/);
    return !m || m[1].split(",").length < 4 || parseFloat(m[1].split(",")[3]) >= 1;
  };
  // Text under an opaque element painted above it (a sticky header, a panel) is hidden, not visibly overlapped:
  // an opaque element that is neither a container nor a contained element of `e`, and sits above it at the point.
  const hiddenUnder = (e, list) => {
    const at = list.findIndex((x) => e.contains(x));
    if (at < 0) return false;
    return list.slice(0, at).some((x) => !x.contains(e) && !e.contains(x) && opaque(x));
  };
  // Two shown parts meet when their shared area is over 2px each way and the topmost element at its centre is one of the two,
  // and neither is hidden under an opaque element above it.
  const meetAt = (a, b, fa, fb) => {
    const l = Math.max(fa.l, fb.l);
    const rt = Math.min(fa.r, fb.r);
    const t = Math.max(fa.t, fb.t);
    const bt = Math.min(fa.b, fb.b);
    if (rt - l <= 2 || bt - t <= 2) return false;
    const list = document.elementsFromPoint((l + rt) / 2, (t + bt) / 2);
    const hit = list[0] ?? null;
    return hit !== null && (a.contains(hit) || b.contains(hit)) && !hiddenUnder(a, list) && !hiddenUnder(b, list);
  };

  // text.overflow: text wider or taller than its box is a defect only when the box clips it (overflow not
  // visible, ellipsis, line-clamp) or the overflowing text lands on another element's box. A glyph past its
  // box edge with nothing under it passes. Ellipsis with the full text in title/aria-label is accepted truncation.
  let textOverflow = 0;
  for (const el of textLeaves) {
    const s = cs(el);
    if (s.display === "inline") continue;
    const ow = !/auto|scroll/.test(s.overflowX) && el.scrollWidth - el.clientWidth > 1;
    const oh = !/auto|scroll/.test(s.overflowY) && el.scrollHeight - el.clientHeight > 1;
    if (!ow && !oh) continue;
    const ellipsis = s.textOverflow === "ellipsis";
    if (ellipsis && (el.title || el.getAttribute("aria-label"))) continue;
    const lines = s.getPropertyValue("-webkit-line-clamp");
    const clamped = lines !== "" && lines !== "none";
    const clipped = (ow && /hidden|clip/.test(s.overflowX)) || (oh && /hidden|clip/.test(s.overflowY)) || ellipsis || clamped;
    const frags = paint(el);
    const onOther = content.find((other) => {
      if (other === el || other.contains(el) || el.contains(other) || toast(other)) return false;
      return frags.some((f) => paint(other).some((g) => meetAt(el, other, f, g)));
    });
    if (!clipped && !onOther) continue;
    textOverflow++;
    const why = clipped ? "clipped" : `overlaps ${describe(onOther)}`;
    note("text.overflow", `${describe(el)} ${why} sw=${el.scrollWidth}/cw=${el.clientWidth} sh=${el.scrollHeight}/ch=${el.clientHeight}`);
  }

  // overlap.interactive: a shown part of one control meets a shown part of another (not nested; see meetAt)
  let overlap = 0;
  for (let i = 0; i < interactive.length; i++) {
    const a = interactive[i];
    for (let j = i + 1; j < interactive.length; j++) {
      const b = interactive[j];
      if (a.contains(b) || b.contains(a) || toast(a) || toast(b)) continue;
      if (!paint(a).some((fa) => paint(b).some((fb) => meetAt(a, b, fa, fb)))) continue;
      overlap++;
      note("overlap.interactive", `${describe(a)} x ${describe(b)}`);
    }
  }

  // obscured.interactive: every shown part of a control has its centre painted by an unrelated element. A part
  // scrolled out or clipped is not shown, so it cannot be covered.
  let obscured = 0;
  for (const el of interactive) {
    const frags = paint(el);
    if (frags.length === 0) continue;
    const hits = frags.map((f) => document.elementFromPoint((f.l + f.r) / 2, (f.t + f.b) / 2));
    const unrelated = hits.every((hit) => hit && hit !== el && !el.contains(hit) && !hit.contains(el) && !toast(hit));
    if (!unrelated) continue;
    obscured++;
    note("obscured.interactive", `${describe(el)} covered by ${describe(hits[0])}`);
  }

  // edges.touching: text, or controls narrower than the viewport, whose shown part lies within 16px of a side edge.
  // A side clipped by a horizontal scroll strip is not an edge: the item continues past it. edges.touching8 counts
  // the stricter 8px band.
  let touching = 0;
  let touching8 = 0;
  for (const el of content) {
    const r = el.getBoundingClientRect();
    if (r.width >= W - 1 && interactive.includes(el)) continue;
    if (r.left < 0 || r.right > W) continue;
    const frags = paint(el);
    if (frags.length === 0) continue;
    const gap = Math.min(...frags.map((sh) => Math.min(sh.stripL ? Infinity : sh.l, sh.stripR ? Infinity : W - sh.r)));
    if (gap >= 16) continue;
    touching++;
    if (gap < 8) touching8++;
    note("edges.touching", `${describe(el)} at x=${Math.round(r.left)}..${Math.round(r.right)}`);
  }

  // edges.coveredByFixed: a control or text under a fixed bar, measured at top and at full scroll
  const coveredNow = () => {
    let n = 0;
    for (const el of content) {
      if (isFixed(el)) continue;
      const r = el.getBoundingClientRect();
      const cx = r.left + r.width / 2;
      const cy = r.top + r.height / 2;
      if (cx < 0 || cy < 0 || cx > W || cy > H) continue;
      const hit = document.elementFromPoint(cx, cy);
      const f = hit ? isFixed(hit) : null;
      if (!f || f.contains(el) || toast(hit)) continue;
      // A full-viewport fixed layer is a scrim: content under it is covered by design, not by a bar.
      const fr = f.getBoundingClientRect();
      if (fr.width >= W - 1 && fr.height >= H - 1) continue;
      n++;
      note("edges.coveredByFixed", `${describe(el)} under fixed ${describe(f)}`);
    }
    return n;
  };
  const scrollBefore = window.scrollY;
  const coveredTop = coveredNow();
  window.scrollTo(0, docScrollH);
  const sy = window.scrollY;
  const docHBottom = doc.scrollHeight;
  let lastBottom = null;
  for (const el of content) {
    if (isFixed(el)) continue;
    const r = el.getBoundingClientRect();
    const bottom = r.bottom + sy;
    if (lastBottom === null || bottom > lastBottom) lastBottom = bottom;
  }
  const bottomGap = lastBottom === null ? null : Math.round(docHBottom - lastBottom);
  const coveredBottom = coveredNow();
  window.scrollTo(0, scrollBefore);

  // targets.small
  let small = 0;
  for (const el of interactive) {
    const s = cs(el);
    if (s.display === "inline") continue;
    const r = el.getBoundingClientRect();
    if (r.width >= minTarget && r.height >= minTarget) continue;
    // a native checkbox/radio whose visible label is big enough is measured by the label
    if (el.labels && [...el.labels].some((l) => visible(l) && l.getBoundingClientRect().height >= minTarget)) continue;
    small++;
    note("targets.small", `${describe(el)} ${Math.round(r.width)}x${Math.round(r.height)}`);
  }

  // targets.touch48.small: touch rows only; controls under 48x48 CSS px (label exemption as above)
  let touch48 = 0;
  if (opts.profile === "touch") {
    for (const el of interactive) {
      if (cs(el).display === "inline") continue;
      const r = el.getBoundingClientRect();
      if (r.width >= 48 && r.height >= 48) continue;
      if (el.labels && [...el.labels].some((l) => visible(l) && l.getBoundingClientRect().height >= 48)) continue;
      touch48++;
      note("targets.touch48.small", `${describe(el)} ${Math.round(r.width)}x${Math.round(r.height)}`);
    }
  }

  // sr.unlabelled: interactive controls with no accessible name
  const nameOf = (el) => {
    const al = el.getAttribute("aria-label");
    if (al && al.trim()) return al;
    const lb = el.getAttribute("aria-labelledby");
    if (lb) {
      const t = lb
        .split(/\s+/)
        .map((id) => document.getElementById(id)?.textContent ?? "")
        .join(" ")
        .trim();
      if (t) return t;
    }
    if (el.labels && el.labels.length) {
      const t = [...el.labels].map((l) => l.textContent).join(" ").trim();
      if (t) return t;
    }
    if (el.tagName === "INPUT" && ["button", "submit", "reset"].includes(el.type) && el.value) return el.value;
    const t = (el.textContent ?? "").trim();
    if (t) return t;
    const inner = el.querySelector("img[alt],svg[aria-label],[aria-label]");
    if (inner) {
      const v = inner.getAttribute("alt") || inner.getAttribute("aria-label");
      if (v) return v;
    }
    return el.title || el.placeholder || "";
  };
  let unlabelled = 0;
  for (const el of interactive) {
    if (el.closest("[aria-hidden=true]")) continue;
    if (nameOf(el).trim()) continue;
    unlabelled++;
    note("sr.unlabelled", describe(el));
  }

  // bleed.violations: data-qa-bleed decoration is aria-hidden and holds no text or focusable control
  let bleedBad = 0;
  for (const el of document.querySelectorAll("[data-qa-bleed]")) {
    const hidden = el.closest("[aria-hidden=true]") !== null;
    const text = (el.textContent ?? "").trim() !== "";
    const focusable = el.querySelector(INTERACTIVE) !== null;
    if (hidden && !text && !focusable) continue;
    bleedBad++;
    note("bleed.violations", describe(el));
  }

  // form.errorsAssociated: an invalid control (aria-invalid or :user-invalid) names a non-empty message in aria-describedby
  let formErrors = 0;
  for (const el of document.querySelectorAll("input:not([type=hidden]),select,textarea")) {
    if (!visible(el)) continue;
    let userInvalid = false;
    try {
      userInvalid = el.matches(":user-invalid");
    } catch {
      // engine without :user-invalid: aria-invalid is the only signal
    }
    const flagged = el.getAttribute("aria-invalid") === "true";
    if (!flagged && !userInvalid) continue;
    const described = (el.getAttribute("aria-describedby") ?? "")
      .split(/\s+/)
      .some((id) => (document.getElementById(id)?.textContent ?? "").trim() !== "");
    if (flagged && described) continue;
    formErrors++;
    note("form.errorsAssociated", describe(el));
  }

  // sr.statusMessages: a visible status, error, notice or toast message sits in a live region or role=status/alert
  let statusMissing = 0;
  for (const el of document.querySelectorAll('[class*="status"],[class*="error"],[class*="toast"],[class*="notice"],[class*="warning"]')) {
    if (!visible(el) || !hasDirectText(el) || bleed(el)) continue;
    if (el.closest("[role=status],[role=alert],[aria-live]")) continue;
    statusMissing++;
    note("sr.statusMessages", describe(el));
  }

  // safe.notch.ok (T3-notch only): no control inside the safe-area insets and bottomGap >= max(16, bottom inset).
  // A fixed or sticky control is checked at every scroll position; normal-flow content only at rest for the top
  // inset and at the scroll end for the bottom inset. Only the shown part of a control counts.
  let notchOk = null;
  if (opts.notch) {
    const { top, bottom } = opts.notch;
    // The page scrolls inside its nearest overflow-y ancestor (the app shell #ui in this app), not the window: a
    // window scroll leaves the positions unchanged. Every position is measured from the top, then the scroll is restored.
    const sc = scrollerOf(document.querySelector("main.page") ?? document.body);
    const at = (y) => { if (sc === doc) window.scrollTo(0, y); else sc.scrollTop = y; };
    const notchScrollBefore = sc === doc ? window.scrollY : sc.scrollTop;
    const maxScroll = Math.max(0, sc === doc ? docScrollH - H : sc.scrollHeight - sc.clientHeight);
    const stepPx = Math.max(16, Math.ceil(maxScroll / 60));
    const positions = [];
    for (let y = 0; y < maxScroll; y += stepPx) positions.push(y);
    positions.push(maxScroll);
    // Pinned means a fixed/sticky box between the control and its scroller: the walk stops at the scroller, so the app shell (#ui, fixed) above it does not pin every control.
    const pinnedOf = new Map(interactive.map((el) => {
      for (let a = el; a && a !== sc && a !== doc; a = a.parentElement) if (/fixed|sticky/.test(cs(a).position)) return [el, true];
      return [el, false];
    }));
    const inInset = new Set();
    for (const y of positions) {
      at(y);
      for (const el of interactive) {
        const pinned = pinnedOf.get(el);
        if (!pinned && y !== 0 && y !== maxScroll) continue;
        const sh = shownRect(el.getBoundingClientRect(), el);
        if (!sh) continue;
        const topIn = sh.t < top && (pinned || y === 0);
        const bottomIn = sh.b > H - bottom && (pinned || y === maxScroll);
        if ((topIn || bottomIn) && !inInset.has(el)) {
          inInset.add(el);
          note("safe.notch.ok", `${describe(el)} inside the safe-area inset at scroll ${Math.round(y)}`);
        }
      }
    }
    at(notchScrollBefore);
    const gapOk = bottomGap === null || bottomGap >= Math.max(16, bottom);
    notchOk = inInset.size === 0 && gapOk ? 1 : 0;
  }

  // zoom.pinchBlocked: 1 when the viewport meta disables pinch zoom (user-scalable=no or maximum-scale=1)
  const viewportMeta = document.querySelector('meta[name="viewport"]')?.content ?? "";
  const pinchBlocked = /user-scalable\s*=\s*(no|0)\b/i.test(viewportMeta) || /maximum-scale\s*=\s*1(\.0*)?\s*(,|$)/i.test(viewportMeta) ? 1 : 0;

  // theme.attrMatches: 1 when <html data-theme> equals the expected theme (only when the capture names one)
  const themeOk = opts.expectTheme ? (document.documentElement.dataset.theme === opts.expectTheme ? 1 : 0) : null;

  // forcedColors.issues (forced axis, approximate): forced colours strip backgrounds and borders, so an
  // icon-only control without a border is invisible, and text with a transparent colour is lost
  let forcedIssues = null;
  if (opts.forced) {
    forcedIssues = 0;
    for (const el of interactive) {
      const s = cs(el);
      const bordered = parseFloat(s.borderTopWidth) > 0 && s.borderTopStyle !== "none";
      if (!bordered && (el.textContent ?? "").trim() === "" && s.backgroundImage !== "none") {
        forcedIssues++;
        note("forcedColors.issues", `${describe(el)} icon-only, no border`);
      }
    }
    for (const el of textLeaves) {
      if (/rgba\(\s*[\d.]+[ ,]+[\d.]+[ ,]+[\d.]+[ ,/]+0(\.0*)?\s*\)|transparent/.test(cs(el).color)) {
        forcedIssues++;
        note("forcedColors.issues", `${describe(el)} text colour is transparent`);
      }
    }
  }

  // balance.offset: area-weighted centroid of content against the viewport centre
  let mx = 0;
  let my = 0;
  let mass = 0;
  for (const el of content) {
    const r = el.getBoundingClientRect();
    const a = r.width * r.height;
    if (r.right < 0 || r.bottom < 0 || r.left > W || r.top > H) continue;
    mx += (r.left + r.width / 2) * a;
    my += (r.top + r.height / 2) * a;
    mass += a;
  }
  const balance = mass > 0 ? Math.hypot(mx / mass - W / 2, my / mass - H / 2) / Math.hypot(W / 2, H / 2) : 0;

  // spacing.inconsistency: coefficient of variation of gaps between the main column's blocks
  let column = document.querySelector("main") ?? document.querySelector("#app") ?? document.body;
  while (column.children.length === 1 && column.firstElementChild) column = column.firstElementChild;
  const blocks = [...column.children].filter((el) => visible(el)).map((el) => el.getBoundingClientRect());
  const gaps = [];
  for (let i = 1; i < blocks.length; i++) {
    const g = blocks[i].top - blocks[i - 1].bottom;
    if (g >= 0) gaps.push(g);
  }
  let spacing = 0;
  if (gaps.length >= 2) {
    const mean = gaps.reduce((s, g) => s + g, 0) / gaps.length;
    const sd = Math.sqrt(gaps.reduce((s, g) => s + (g - mean) ** 2, 0) / gaps.length);
    spacing = mean > 0 ? sd / mean : 0;
  }

  // inputs for the pixel pass: text over media, and control borders
  const mediaRects = [];
  for (const el of all) {
    if (el.matches("canvas,img,video,svg") || (cs(el).backgroundImage && cs(el).backgroundImage !== "none")) {
      if (!visible(el)) continue;
      const r = el.getBoundingClientRect();
      mediaRects.push({ l: r.left, t: r.top, r: r.right, b: r.bottom });
    }
  }
  const parseColour = (str) => {
    const m = str.match(/rgba?\(([^)]+)\)/);
    if (!m) return null;
    const p = m[1].split(/[ ,/]+/).filter(Boolean).map(Number);
    return { rgb: [p[0], p[1], p[2]], a: p[3] ?? 1 };
  };
  const texts = [];
  for (const el of textLeaves) {
    // WCAG 1.4.3: text of an inactive component (a disabled control, e.g. Start until a choice is made) has no contrast requirement.
    if (el.closest(':disabled, [aria-disabled="true"]')) continue;
    const c = parseColour(cs(el).color);
    if (!c || c.a < 1) continue;
    const size = parseFloat(cs(el).fontSize);
    const bold = parseInt(cs(el).fontWeight, 10) >= 700;
    for (const glyphs of textRects(el)) {
      const shown = shownRect(glyphs, el);
      if (!shown) continue;
      const overMedia = mediaRects.some((m) => m.l < shown.r && m.r > shown.l && m.t < shown.b && m.b > shown.t);
      if (!overMedia) continue;
      // Painted over at its visible centre (a scrim, dialog or other element on top): the pixels there are not the text's background.
      const hit = document.elementFromPoint((shown.l + shown.r) / 2, (shown.t + shown.b) / 2);
      if (!hit || (hit !== el && !el.contains(hit) && !hit.contains(el))) continue;
      texts.push({
        rect: { x: shown.l, y: shown.t, w: shown.r - shown.l, h: shown.b - shown.t },
        fg: c.rgb,
        large: size >= 24 || (bold && size >= 18.66),
        desc: describe(el),
      });
    }
  }
  const controls = [];
  for (const el of interactive) {
    const s = cs(el);
    if (parseFloat(s.borderTopWidth) <= 0 || s.borderTopStyle === "none") continue;
    const c = parseColour(s.borderTopColor);
    if (!c || c.a < 0.5) continue;
    const r = el.getBoundingClientRect();
    controls.push({ rect: { x: r.left, y: r.top, w: r.width, h: r.height }, border: c.rgb, desc: describe(el) });
  }

  const metrics = {
    "overflow.docX": docX,
    "overflow.docY_unexpected": docY,
    "overflow.offscreen": offscreen,
    "text.overflow": textOverflow,
    "overlap.interactive": overlap,
    "obscured.interactive": obscured,
    "edges.touching": touching,
    "edges.bottomGap": bottomGap,
    "edges.coveredByFixed": Math.max(coveredTop, coveredBottom),
    "targets.small": small,
    "sr.unlabelled": unlabelled,
    "balance.offset": Number(balance.toFixed(4)),
    "spacing.inconsistency": Number(spacing.toFixed(4)),
    "edges.touching8": touching8,
    "targets.touch48.small": touch48,
    "bleed.violations": bleedBad,
    "form.errorsAssociated": formErrors,
    "sr.statusMessages": statusMissing,
    "zoom.pinchBlocked": pinchBlocked,
  };
  if (themeOk !== null) metrics["theme.attrMatches"] = themeOk;
  if (notchOk !== null) metrics["safe.notch.ok"] = notchOk;
  if (forcedIssues !== null) metrics["forcedColors.issues"] = forcedIssues;
  return {
    metrics,
    details,
    texts,
    controls,
    info: { interactive: interactive.length, content: content.length, dialog: modal ? describe(modal) : null, scrollH: docScrollH, viewport: [W, H] },
  };
}

/** Layout problems behind the zoom and text-scale passes: overflow, text clipping, overlap. */
const REFLOW_KEYS = ["overflow.docX", "text.overflow", "overlap.interactive", "overflow.offscreen"];

/** Count of reflow problems in a domMeasure result. */
export function reflowIssues(dom) {
  return REFLOW_KEYS.reduce((n, key) => n + dom.metrics[key], 0);
}

/** The problems behind reflowIssues, one line each, prefixed with their metric key (record details). */
export function reflowDetails(dom) {
  return REFLOW_KEYS.flatMap((key) => (dom.details[key] ?? []).map((text) => `${key}: ${text}`));
}

/** Waits for two painted frames, so a style or viewport change has applied before the next measure. */
export const nextFrames = (page) =>
  page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));

/** Elements still animating (over 10 ms) with prefers-reduced-motion: reduce. */
export async function reducedMotion(page, restore = "no-preference") {
  await page.emulateMedia({ reducedMotion: "reduce" });
  try {
    await nextFrames(page);
    return await page.evaluate(() => {
      const running = document.getAnimations().filter((a) => {
        if (a.playState !== "running") return false;
        const t = a.effect?.getComputedTiming();
        return t && t.duration > 10;
      });
      return {
        count: running.length,
        names: running.slice(0, 20).map((a) => {
          const target = a.effect?.target;
          return target ? `${target.tagName.toLowerCase()}${target.className && typeof target.className === "string" ? `.${target.className.split(" ")[0]}` : ""}` : "(no target)";
        }),
      };
    });
  } finally {
    await page.emulateMedia({ reducedMotion: restore });
  }
}

/** axe-core WCAG 2.2 AA and best-practice rules; counts violating nodes per impact. */
export async function axeCounts(page) {
  const present = await page.evaluate(() => typeof window.axe !== "undefined");
  // page.evaluate runs over CDP, outside the page's CSP; addScriptTag would inject an inline script and be blocked.
  if (!present) await page.evaluate(await readFile(AXE_PATH, "utf8"));
  const result = await page.evaluate(async () => {
    const res = await window.axe.run(document, {
      runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa", "best-practice"] },
      resultTypes: ["violations"],
    });
    const out = { critical: 0, serious: 0, moderate: 0, minor: 0, rules: [] };
    for (const v of res.violations) {
      const impact = v.impact ?? "minor";
      out[impact] = (out[impact] ?? 0) + v.nodes.length;
      out.rules.push(`${impact}:${v.id}(${v.nodes.length})`);
    }
    return out;
  });
  return result;
}
