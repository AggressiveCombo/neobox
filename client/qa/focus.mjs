// Keyboard focus audit for one page state: walks the tab order once with Tab and reports
// focus.invisible (no visible indicator, or covered), focus.obscured (centre covered by a fixed or sticky
// element, every Tab stop), focus.order.jumps (visual backward jumps) and focus.trapBroken (focus leaves an
// open modal dialog).

import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { differingPixels } from "./image.mjs";
import { nextFrames } from "./metrics.mjs";

// A focus indicator must change at least this many pixels (by colour distance > 24) in the crop.
const MIN_RING_PIXELS = 6;
// Context around the element in the indicator crop: a 2px ring with a 2px offset lies 4px out, so 8px keeps it whole.
const RING_MARGIN = 8;
// A backward move counts as a jump when it goes up by more than this many element heights.
const JUMP_ROWS = 1.5;

/** Runs in the page: reports the focused element, registering it so Node can refocus it later. */
function describeFocus() {
  const el = document.activeElement;
  if (!el || el === document.body || el === document.documentElement) return null;
  if (!window.__qaById) {
    window.__qaById = new Map();
    window.__qaIds = new WeakMap();
    window.__qaNext = 1;
  }
  let id = window.__qaIds.get(el);
  if (!id) {
    id = window.__qaNext++;
    window.__qaIds.set(el, id);
    window.__qaById.set(id, el);
  }
  const r = el.getBoundingClientRect();
  const dlg = [...document.querySelectorAll('[role=dialog],[role=alertdialog],dialog[open]')].filter((d) => {
    const dr = d.getBoundingClientRect();
    return dr.width > 0 && dr.height > 0;
  });
  const modal = dlg[dlg.length - 1] ?? null;
  const cx = r.left + r.width / 2;
  const cy = r.top + r.height / 2;
  // The centre of the part of the element the reader sees (inside the viewport and each clipping ancestor), so an
  // item scrolled half out of a scroller is tested where it shows, not at its raw centre. Copy of metrics.mjs shownRect.
  const shown = (() => {
    let l = Math.max(r.left, 0);
    let t = Math.max(r.top, 0);
    let rt = Math.min(r.right, innerWidth);
    let b = Math.min(r.bottom, innerHeight);
    for (let a = el.parentElement; a && a !== document.body && a !== document.documentElement; a = a.parentElement) {
      const s = getComputedStyle(a);
      if (s.display === "inline") continue;
      const clipX = /hidden|auto|scroll|clip/.test(s.overflowX);
      const clipY = /hidden|auto|scroll|clip/.test(s.overflowY);
      if (!clipX && !clipY) continue;
      const ar = a.getBoundingClientRect();
      const pl = ar.left + a.clientLeft;
      const pt = ar.top + a.clientTop;
      if (clipX) {
        l = Math.max(l, pl);
        rt = Math.min(rt, pl + a.clientWidth);
      }
      if (clipY) {
        t = Math.max(t, pt);
        b = Math.min(b, pt + a.clientHeight);
      }
    }
    return rt - l > 0 && b - t > 0 ? { x: (l + rt) / 2, y: (t + b) / 2 } : null;
  })();
  // not rendered (display/visibility/opacity, or inside a closed <details>): it cannot be seen, so it cannot be covered
  const closedDetails = el.closest("details:not([open])");
  const rendered =
    (el.checkVisibility?.({ checkOpacity: true, checkVisibilityCSS: true }) ?? true) &&
    !(closedDetails && closedDetails !== el && !el.closest("summary"));
  const inView = rendered && cx >= 0 && cy >= 0 && cx <= innerWidth && cy <= innerHeight;
  const hit = inView && shown ? document.elementFromPoint(shown.x, shown.y) : null;
  const covered = hit !== null && hit !== el && !el.contains(hit) && !hit.contains(el);
  // Covered by a fixed or sticky element: the hit or one of its ancestors is positioned that way.
  let obscured = false;
  for (let n = covered && !hit.closest("#toasts") ? hit : null; n; n = n.parentElement) {
    const pos = getComputedStyle(n).position;
    if (pos === "fixed" || pos === "sticky") {
      obscured = true;
      break;
    }
  }
  // A toast is pointer-events none, so it never shows as a hit: it obscures focus only when one toast item fully contains it.
  if (!obscured && inView) {
    obscured = [...document.querySelectorAll("#toasts > *")].some((t) => {
      const tr = t.getBoundingClientRect();
      return !t.contains(el) && tr.width > 0 && tr.height > 0 && tr.left <= r.left && tr.top <= r.top && tr.right >= r.right && tr.bottom >= r.bottom;
    });
  }
  const name = (el.getAttribute("aria-label") || el.textContent || el.value || el.id || el.tagName).trim().replace(/\s+/g, " ").slice(0, 40);
  return {
    id,
    tag: el.tagName.toLowerCase(),
    name,
    rect: { x: r.left, y: r.top, w: r.width, h: r.height },
    inView,
    covered,
    obscured,
    inDialog: modal ? modal.contains(el) : null,
    hasDialog: modal !== null,
  };
}

/** Runs in the page: the viewport rect of a registered element, or null when it is gone. */
function rectOfId(id) {
  const el = window.__qaById?.get(id);
  if (!el) return null;
  const r = el.getBoundingClientRect();
  return { x: r.left, y: r.top, w: r.width, h: r.height };
}

/** Waits for the focused element's running CSS transitions and animations, so the crop is taken at rest. */
async function settle(page) {
  await nextFrames(page);
  await page.evaluate(() =>
    Promise.race([
      Promise.all(
        document
          .getAnimations()
          .filter((a) => a.playState === "running" && Number.isFinite(a.effect?.getComputedTiming().endTime))
          .map((a) => a.finished.catch(() => {})),
      ),
      new Promise((resolve) => setTimeout(resolve, 500)),
    ]),
  );
  await nextFrames(page);
}

/** The crop of the focused element the indicator test compares (element plus RING_MARGIN), or null when too small. */
async function cropOf(page, cur) {
  const vw = await page.evaluate(() => ({ w: innerWidth, h: innerHeight }));
  const x0 = Math.max(0, cur.rect.x - RING_MARGIN);
  const y0 = Math.max(0, cur.rect.y - RING_MARGIN);
  const x1 = Math.min(vw.w, cur.rect.x + cur.rect.w + RING_MARGIN);
  const y1 = Math.min(vw.h, cur.rect.y + cur.rect.h + RING_MARGIN);
  if (x1 - x0 < 2 || y1 - y0 < 2) return null;
  return { x: x0, y: y0, width: x1 - x0, height: y1 - y0 };
}

/**
 * Compares a crop of the focused element with and without focus. Returns { visible, focused, blurred }: `visible`
 * is false when no indicator is drawn; the PNG crops are null when the element is too small to test.
 */
async function focusIndicatorVisible(page, cur) {
  const clip = await cropOf(page, cur);
  if (!clip) return { visible: true, focused: null, blurred: null };
  const focused = await page.screenshot({ clip, animations: "disabled", caret: "hide" });
  await page.evaluate((id) => window.__qaById.get(id)?.blur(), cur.id);
  await settle(page);
  const blurred = await page.screenshot({ clip, animations: "disabled", caret: "hide" });
  await page.evaluate((id) => window.__qaById.get(id)?.focus({ preventScroll: true }), cur.id);
  const diff = differingPixels(focused, blurred);
  return { visible: diff < 0 ? true : diff >= MIN_RING_PIXELS, focused, blurred };
}

/** Writes the crops behind failure `n` of focus.invisible (focused, and blurred when taken) into `dir`. */
function saveFocusEvidence(dir, n, { focused, blurred }) {
  mkdirSync(dir, { recursive: true });
  if (focused) writeFileSync(path.join(dir, `focus-invisible-${n}-focused.png`), focused);
  if (blurred) writeFileSync(path.join(dir, `focus-invisible-${n}-blurred.png`), blurred);
}

/**
 * Walks Tab from the top of the document until focus cycles back or `maxSteps` is hit.
 * `dialog` = true when a modal is expected to trap focus (the walk then reports escapes).
 * `indicator` = true only on T1-K, the one row the rubric assigns focus.invisible to (section 3 D07);
 * other rows walk order and dialog traps only, and emit no focus.invisible key.
 * `evidenceDir` = directory that receives the focused and blurred crops of each focus.invisible failure.
 */
export async function focusWalk(page, { maxSteps = 80, dialog = false, indicator = false, evidenceDir = null } = {}) {
  const metrics = { "focus.obscured": 0, "focus.order.jumps": 0, "focus.trapBroken": 0 };
  const details = { "focus.obscured": [], "focus.order.jumps": [], "focus.trapBroken": [] };
  if (indicator) {
    metrics["focus.invisible"] = 0;
    details["focus.invisible"] = [];
  }
  const push = (key, text) => {
    if (details[key].length < 60) details[key].push(text);
  };

  await page.evaluate(() => document.activeElement?.blur());
  await page.evaluate(() => window.scrollTo(0, 0));
  const seen = new Set();
  let prev = null;
  for (let step = 0; step < maxSteps; step++) {
    await page.keyboard.press("Tab");
    await settle(page);
    const cur = await page.evaluate(describeFocus);
    if (cur === null) break; // focus left the document (browser chrome or nothing focusable left)
    if (seen.has(cur.id)) break; // one full cycle
    seen.add(cur.id);
    const where = `${cur.tag} "${cur.name}"`;

    if (dialog && cur.hasDialog && cur.inDialog === false && (prev === null || prev.inDialog !== false)) {
      metrics["focus.trapBroken"]++;
      push("focus.trapBroken", `focus left the open dialog to ${where}`);
    }

    // Focusing cur can scroll its container, which moves prev too. Both are compared in the scroll state
    // cur was focused in, so only a real order change in the content counts.
    if (prev && cur.rect && cur.inView) {
      const before = await page.evaluate(rectOfId, prev.id);
      // A move to a column on the right (the next column of a multi-column layout, starting at or past
      // the previous element's right edge) is reading order, not disorder: only up-moves within a column count.
      const nextColumn = before && cur.rect.x >= before.x + before.w - 1;
      if (before && before.h > 0 && !nextColumn) {
        const drop = before.y - cur.rect.y;
        const rowH = Math.max(before.h, cur.rect.h);
        if (drop > JUMP_ROWS * rowH) {
          metrics["focus.order.jumps"]++;
          push("focus.order.jumps", `up ${Math.round(drop)}px from "${prev.name}" to ${where}`);
        }
      }
    }

    if (cur.obscured) {
      metrics["focus.obscured"]++;
      push("focus.obscured", `${where} covered by a fixed or sticky element`);
    }

    if (indicator && cur.covered) {
      metrics["focus.invisible"]++;
      push("focus.invisible", `${where} covered by another element`);
      const clip = evidenceDir && (await cropOf(page, cur));
      if (clip) saveFocusEvidence(evidenceDir, metrics["focus.invisible"], { focused: await page.screenshot({ clip, animations: "disabled", caret: "hide" }) });
    } else if (indicator && cur.inView) {
      const shot = await focusIndicatorVisible(page, cur);
      if (!shot.visible) {
        metrics["focus.invisible"]++;
        push("focus.invisible", `${where} shows no focus indicator`);
        if (evidenceDir) saveFocusEvidence(evidenceDir, metrics["focus.invisible"], shot);
      }
    }

    prev = cur;
  }
  return { metrics, details, steps: seen.size };
}
