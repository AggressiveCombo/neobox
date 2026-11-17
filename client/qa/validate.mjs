// Detector self-test: every threshold in thresholds.json must fire on the fixture that injects its
// problem, and the clean fixtures must produce zero failures. Each fixture is a bare page set with
// setContent and measured by the same measureState() the sweep uses, on a row (viewport, DPR, input)
// and an axis (settings media) the fixture names.
//
// Usage (from client/): bun qa/validate.mjs [--engines chromium,firefox,webkit]
// Exit code 1 when a detector misses its problem, a clean fixture fails, or a threshold has no fixture.

import { launchEngine, runCleanups } from "../e2e/lib.mjs";
import { measureState, trackPage } from "./capture.mjs";
import { nextFrames } from "./metrics.mjs";
import { THRESHOLDS, validateRecord } from "./thresholds.mjs";

const FIXTURE_ROW = { id: "fixture", W: 1280, H: 800, dsf: 1, input: "M" };
const TOUCH_ROW = { id: "fixture-T", W: 390, H: 844, dsf: 2, input: "T" };
const NOTCH_ROW = { id: "fixture-notch", W: 390, H: 844, dsf: 2, input: "T", notch: { top: 47, bottom: 34 } };
const NET_HOST = "https://qa-selftest.invalid";

const CSS = `body{margin:0;padding:16px 16px 24px;font:16px/1.4 system-ui,sans-serif;color:#222;background:#fff}
button{font:inherit;min-width:44px;min-height:32px;padding:8px 14px;color:#222;background:#fff;border:1px solid #767676;border-radius:4px}
button:focus{outline:3px solid #005fcc;outline-offset:2px}`;

// A `head` that sets its own viewport meta replaces the default one (the detectors read the first meta).
const doc = (body, css = "", head = "") => {
  const viewport = head.includes('name="viewport"') ? "" : '<meta name="viewport" content="width=device-width,initial-scale=1">';
  return `<!doctype html><html lang="en" data-theme="light"><head><meta charset="utf-8">${viewport}${head}<title>QA self-test</title><style>${CSS}${css}</style></head><body>${body}</body></html>`;
};
const main = (inner) => `<main>${inner}</main>`;

/**
 * Each fixture names the thresholds it must trip (`keys`), or none for a clean fixture. `fit` and
 * `dialog` set the same flags a state would carry; `row` and `axis` pick the capture geometry and the
 * settings media (default: FIXTURE_ROW, no axis); `expectTheme` is the theme the page must show.
 */
const FIXTURES = [
  { name: "clean", keys: [], html: doc(main(`<h1>Clean fixture</h1><p>Plain text that wraps inside the column.</p><button>Continue</button>`)) },
  {
    name: "clean-dialog",
    keys: [],
    dialog: true,
    html: doc(
      main(`<h1>Clean fixture</h1><p>Background text.</p>`) +
        `<div role="dialog" aria-modal="true" aria-label="Confirm" style="position:fixed;left:50%;top:50%;transform:translate(-50%,-50%);background:#fff;border:1px solid #767676;padding:16px"><p>Are you sure?</p><button>Yes</button> <button>No</button></div>`,
    ),
  },
  { name: "overflow.docX", keys: ["overflow.docX"], html: doc(main(`<div style="width:2000px;height:20px;background:#eee"></div>`)) },
  { name: "overflow.docY", keys: ["overflow.docY_unexpected"], fit: true, html: doc(main(`<div style="height:2000px"></div>`)) },
  {
    name: "overflow.offscreen",
    keys: ["overflow.offscreen"],
    html: doc(main(`<p style="position:absolute;left:-60px;top:100px;margin:0">Cut off text</p>`)),
  },
  {
    name: "text.overflow",
    keys: ["text.overflow"],
    html: doc(main(`<div style="width:60px;height:20px;overflow:hidden;white-space:nowrap">A very long label that cannot fit</div>`)),
  },
  {
    name: "text.overflow glyph",
    keys: [],
    html: doc(main(`<h1>Glyph fixture</h1><span style="display:inline-block;width:40px;white-space:nowrap">Overhang glyph</span>`)),
  },
  {
    name: "text.overflow overlap",
    keys: ["text.overflow"],
    html: doc(main(`<span style="display:inline-block;width:40px;white-space:nowrap">Overhang glyph</span><button style="position:absolute;left:60px;top:0">Go</button>`)),
  },
  {
    // A link wrapped onto two lines: line 2 sits left of the button, and only the link's bounding box reaches it.
    name: "overlap.wrappedLink",
    keys: [],
    html: doc(
      main(
        `<h1>Link fixture</h1><div style="position:absolute;left:16px;top:200px"><a href="#" style="line-height:20px">Terms of service and<br>policy</a><button style="position:absolute;left:90px;top:22px">Accept</button></div>`,
      ),
    ),
  },
  {
    // The same link with the button over its first line: that fragment is covered, so overlap.interactive must fire.
    name: "overlap.wrappedLink.covered",
    keys: ["overlap.interactive"],
    html: doc(
      main(
        `<div style="position:absolute;left:16px;top:200px"><a href="#" style="line-height:20px">Terms of service and<br>policy</a><button style="position:absolute;left:90px;top:2px">Accept</button></div>`,
      ),
    ),
  },
  {
    // A label whose line box (40px) runs past its 20px box: the glyphs stop above the control, so nothing may fire.
    name: "text.overflow.lineBoxClean",
    keys: [],
    html: doc(
      main(
        `<h1>Line box fixture</h1><div style="position:absolute;left:16px;top:200px;width:300px;height:20px;line-height:40px;white-space:nowrap">Line box label</div><button style="position:absolute;left:16px;top:236px">Next</button>`,
      ),
    ),
  },
  {
    // The same label with its glyphs over the control: text.overflow must fire.
    name: "text.overflow.lineBoxCovered",
    keys: ["text.overflow"],
    html: doc(
      main(
        `<div style="position:absolute;left:16px;top:200px;width:300px;height:20px;line-height:40px;white-space:nowrap">Line box label</div><button style="position:absolute;left:16px;top:214px">Next</button>`,
      ),
    ),
  },
  {
    name: "overlap.interactive",
    keys: ["overlap.interactive"],
    html: doc(main(`<div style="position:relative;height:60px"><button style="position:absolute;left:10px;top:10px">One</button><button style="position:absolute;left:40px;top:10px">Two</button></div>`)),
  },
  {
    // A control clipped by its scroll region: its hidden part sits under the control below, which is outside the region.
    name: "overlap.scrollClipClean",
    keys: [],
    html: doc(
      main(
        `<h1>Scroll clip fixture</h1><div tabindex="0" role="region" aria-label="Clipped list" style="position:absolute;left:16px;top:200px;width:200px;height:60px;overflow:hidden"><button style="position:absolute;left:0;top:30px;min-height:48px">Inner</button></div><button style="position:absolute;left:16px;top:262px">Outer</button>`,
      ),
    ),
  },
  {
    name: "obscured.interactive",
    keys: ["obscured.interactive"],
    html: doc(main(`<button style="position:absolute;left:100px;top:100px">Hidden</button><div style="position:absolute;left:0;top:0;width:400px;height:300px;background:#fff"></div>`)),
  },
  {
    // The clipped control's visible part is covered by the control below: obscured.interactive must fire.
    name: "obscured.clippedCovered",
    keys: ["obscured.interactive"],
    html: doc(
      main(
        `<div style="position:absolute;left:16px;top:200px;width:200px;height:60px;overflow:hidden"><button style="position:absolute;left:0;top:50px">Inner</button></div><button style="position:absolute;left:16px;top:252px">Outer</button>`,
      ),
    ),
  },
  {
    name: "edges.touching",
    keys: ["edges.touching"],
    html: doc(main(`<p style="position:absolute;left:2px;top:200px;margin:0">Edge</p>`)),
  },
  {
    name: "edges.touching8",
    keys: ["edges.touching8"],
    html: doc(main(`<p style="position:absolute;left:5px;top:200px;margin:0">Edge</p>`)),
  },
  {
    // An item at the left edge of an intentional horizontal scroll strip: its clipped side is not a page edge.
    name: "edges.scrollStripClean",
    keys: [],
    html: doc(
      main(
        `<h1>Strip fixture</h1><div id="strip" style="position:absolute;left:4px;top:200px;width:300px;overflow-x:auto;white-space:nowrap"><button style="width:120px">Item one</button> <button style="width:120px">Item two</button> <button style="width:120px">Item three</button></div><script>document.getElementById("strip").scrollLeft = 2;</script>`,
      ),
    ),
  },
  {
    // The same item in a hidden-overflow box: nothing scrolls it, so its 4px side is a real edge.
    name: "edges.hiddenStripEdge",
    keys: ["edges.touching"],
    html: doc(
      main(
        `<div id="strip" style="position:absolute;left:4px;top:200px;width:300px;overflow-x:hidden;white-space:nowrap"><button style="width:120px">Item one</button> <button style="width:120px">Item two</button> <button style="width:120px">Item three</button></div><script>document.getElementById("strip").scrollLeft = 2;</script>`,
      ),
    ),
  },
  {
    name: "edges.bottomGap",
    keys: ["edges.bottomGap"],
    html: doc(main(`<p style="margin:0;height:100vh">Bottom</p>`), "body{padding:0}"),
  },
  {
    name: "edges.coveredByFixed",
    keys: ["edges.coveredByFixed"],
    html: doc(main(`<button>Under bar</button>`) + `<div style="position:fixed;top:0;left:0;right:0;height:60px;background:#222;z-index:10"></div>`),
  },
  {
    name: "targets.small",
    keys: ["targets.small"],
    html: doc(main(`<button aria-label="Tiny close" style="width:12px;height:12px;padding:0;min-width:0;min-height:0"></button>`)),
  },
  {
    name: "targets.touch48.small",
    keys: ["targets.touch48.small"],
    row: TOUCH_ROW,
    html: doc(main(`<button aria-label="Small" style="width:40px;height:40px;padding:0;min-width:0;min-height:0"></button>`)),
  },
  {
    name: "bleed.violations",
    keys: ["bleed.violations"],
    html: doc(main(`<div data-qa-bleed style="position:absolute;left:0;top:300px;width:100px;height:40px">Decor with text</div>`)),
  },
  {
    name: "form.errorsAssociated",
    keys: ["form.errorsAssociated"],
    html: doc(main(`<label for="qa-name">Name</label> <input id="qa-name" aria-invalid="true">`)),
  },
  {
    name: "sr.unlabelled",
    keys: ["sr.unlabelled"],
    html: doc(main(`<button><svg width="20" height="20" viewBox="0 0 20 20"><path d="M2 2L18 18" stroke="#222" stroke-width="2"/></svg></button>`)),
  },
  {
    name: "sr.statusMessages",
    keys: ["sr.statusMessages"],
    html: doc(main(`<div class="toast">Saved successfully</div>`)),
  },
  {
    name: "contrast.fails",
    keys: ["contrast.fails"],
    html: doc(main(`<div style="width:400px;height:120px;background:linear-gradient(90deg,#f5f5f5,#fafafa)"><p style="margin:0;padding:24px;color:#e8e8e8;font-size:20px">Pale text over pale image</p></div>`)),
  },
  {
    name: "contrast.nonText.fails",
    keys: ["contrast.nonText.fails"],
    html: doc(main(`<button style="background:#fff;border:2px solid #f2f2f2">Faint border</button>`)),
  },
  {
    name: "contrast.more.fails",
    keys: ["contrast.more.fails"],
    axis: "more",
    html: doc(main(`<div style="width:400px;height:120px;background:linear-gradient(90deg,#f5f5f5,#fafafa)"><p style="margin:0;padding:24px;color:#e8e8e8;font-size:20px">Pale text over pale image</p></div>`)),
  },
  {
    // Pale text scrolled out of a 60px scroll box (its rect is outside the box): it is not seen, so no contrast check.
    name: "contrast.scrollOut",
    keys: [],
    html: doc(
      main(
        `<h1>Scroll fixture</h1><div style="height:60px;overflow:hidden;background:linear-gradient(90deg,#f5f5f5,#fafafa)"><div style="height:200px"></div><p style="margin:0;padding:8px;color:#e8e8e8;font-size:20px">Pale text scrolled out</p></div>`,
      ),
    ),
  },
  {
    // Pale text under a dark scrim: the scrim paints over the text, so the text's pixels are not its background.
    name: "contrast.scrim",
    keys: [],
    html: doc(
      main(`<div style="width:400px;height:120px;background:linear-gradient(90deg,#f5f5f5,#fafafa)"><p style="margin:0;padding:24px;color:#e8e8e8;font-size:20px">Pale text under scrim</p></div>`) +
        `<div style="position:fixed;inset:0;background:rgba(0,0,0,.7)"></div>`,
    ),
  },
  {
    // Text below a clipped dialog edge over a dark scrim: the dialog clips it, so nothing of it is seen.
    name: "contrast.dialogEdge",
    keys: [],
    html: doc(
      main(`<h1>Dialog edge fixture</h1>`) +
        `<div style="position:fixed;inset:0;background:rgba(0,0,0,.7)"></div>` +
        `<div role="dialog" aria-modal="true" aria-label="Notice" style="position:fixed;left:40px;top:40px;width:400px;height:60px;overflow:hidden;background:linear-gradient(90deg,#f5f5f5,#fafafa);z-index:5"><p style="margin:0;padding:80px 24px 0;color:#e8e8e8;font-size:20px">Pale text below the edge</p></div>`,
    ),
  },
  {
    // Pale text whose top is visible inside a clipped box: the visible part is measured, so it must fail.
    name: "contrast.clipped.visible",
    keys: ["contrast.fails"],
    html: doc(main(`<div style="width:400px;height:60px;overflow:hidden;background:linear-gradient(90deg,#f5f5f5,#fafafa)"><p style="margin:0;padding:8px 24px;color:#e8e8e8;font-size:20px">Pale text, top edge visible</p></div>`)),
  },
  {
    // Text under a toast: the toast host is an expected overlay, so text.overflow must not count the overlap.
    name: "text.overflow.toastClean",
    keys: [],
    html: doc(
      main(
        `<h1>Toast text fixture</h1><p style="position:absolute;left:40px;top:200px;margin:0">Text under a toast</p>` +
          `<div id="toasts" style="position:fixed;left:40px;top:190px;width:300px;height:40px;pointer-events:none"><div>Saved</div></div>`,
      ),
    ),
  },
  {
    // A control under a toast's control: the toast host is excluded from overlap.interactive and obscured.interactive.
    name: "overlap.toastClean",
    keys: [],
    html: doc(
      main(
        `<h1>Toast overlap fixture</h1><button style="position:absolute;left:40px;top:200px">One</button>` +
          `<div id="toasts" style="position:fixed;left:0;top:190px;pointer-events:none"><button style="pointer-events:auto;position:absolute;left:30px;top:0">Undo</button></div>`,
      ),
    ),
  },
  {
    // A toast item fully containing the focused button obscures it.
    name: "focus.obscured.toast",
    keys: ["focus.obscured"],
    html: doc(
      main(
        `<h1>Toast focus fixture</h1><button style="position:absolute;left:16px;top:200px">Under toast</button>` +
          `<div id="toasts" style="position:fixed;left:0;top:0;pointer-events:none"><div style="position:fixed;left:0;top:180px;width:300px;height:80px;background:#fff">Saved</div></div>`,
      ),
    ),
  },
  {
    // A toast clear of the focused button: nothing may fire.
    name: "focus.obscured.toastClean",
    keys: [],
    html: doc(
      main(
        `<h1>Toast focus fixture</h1><button style="position:absolute;left:16px;top:200px">Clear of toast</button>` +
          `<div id="toasts" style="position:fixed;left:0;top:0;pointer-events:none"><div style="position:fixed;left:40px;top:100px;width:300px;height:40px;background:#fff">Saved</div></div>`,
      ),
    ),
  },
  {
    // A toast that only partly covers the focused button does not obscure it (it must fully contain it): nothing may fire.
    name: "focus.obscured.toastPartial",
    keys: [],
    html: doc(
      main(
        `<h1>Toast focus fixture</h1><button style="position:absolute;left:16px;top:200px">Partly under toast</button>` +
          `<div id="toasts" style="position:fixed;left:0;top:0;pointer-events:none"><div style="position:fixed;left:40px;top:180px;width:300px;height:80px;background:#fff">Saved</div></div>`,
      ),
    ),
  },
  {
    name: "focus.invisible",
    keys: ["focus.invisible"],
    row: { ...FIXTURE_ROW, id: "T1-K", input: "K" },
    html: doc(main(`<button class="plain">One</button> <button class="plain">Two</button>`), "button.plain:focus{outline:none}"),
  },
  {
    // A fixed bar paints over the only Tab stop: its centre is covered by a fixed element.
    name: "focus.obscured",
    keys: ["focus.obscured"],
    html: doc(
      main(
        `<h1>Fixed bar fixture</h1><button style="position:absolute;left:16px;top:200px">Under bar</button>` +
          `<div style="position:fixed;left:40px;top:180px;width:300px;height:60px;background:#fff">Fixed bar</div>`,
      ),
    ),
  },
  {
    // The same fixed bar, clear of the Tab stop: nothing may fire.
    name: "focus.obscured.clean",
    keys: [],
    html: doc(
      main(
        `<h1>Fixed bar fixture</h1><button style="position:absolute;left:16px;top:200px">Clear of bar</button>` +
          `<div style="position:fixed;left:40px;top:100px;width:200px;height:40px;background:#fff">Fixed bar</div>`,
      ),
    ),
  },
  {
    // Controls inside a closed <details>, under a fixed dock: not rendered, so no detector may fire on them.
    name: "obscured.closedDetails",
    keys: [],
    html: doc(
      main(
        `<h1>Closed details fixture</h1><details style="position:absolute;left:16px;top:24px;width:300px"><summary style="min-height:48px">More options</summary><input aria-label="Name" style="min-height:48px;width:200px"><button style="min-height:48px">Save</button></details>` +
          `<div style="position:fixed;left:16px;right:16px;top:70px;height:80px;background:#fff">Fixed dock</div>`,
      ),
    ),
  },
  {
    name: "focus.order.jumps",
    keys: ["focus.order.jumps"],
    html: doc(main(`<button style="position:absolute;left:16px;top:300px">Lower first</button><button style="position:absolute;left:16px;top:20px">Upper second</button>`)),
  },
  {
    // Reading order across two columns: down the left column, then the top of the right column. Not a jump.
    name: "focus.order.twoColumns",
    keys: [],
    html: doc(
      main(
        `<h1>Two column fixture</h1>` +
        `<button style="position:absolute;left:16px;top:20px;width:120px">Left one</button>` +
          `<button style="position:absolute;left:16px;top:80px;width:120px">Left two</button>` +
          `<button style="position:absolute;left:300px;top:20px;width:120px">Right one</button>`,
      ),
    ),
  },
  {
    // Monotone order in a scroll container: each Tab scrolls the container, which must not read as a jump.
    name: "focus.order.tallScroll",
    keys: [],
    html: doc(
      main(
        `<h1>Tall scroll fixture</h1><div style="height:120px;overflow:auto;border:1px solid #ccc">` +
          [1, 2, 3].map((n) => `<button style="display:block;margin:0 0 110px">Row ${n}</button>`).join("") +
          `</div>`,
      ),
    ),
  },
  {
    // A real upward move inside a scroll container: the second Tab target sits above the first.
    name: "focus.order.scrollJump",
    keys: ["focus.order.jumps"],
    html: doc(
      main(
        `<div style="position:relative;height:240px;overflow:auto;border:1px solid #ccc">` +
          `<button style="position:absolute;left:0;top:500px">Lower first</button>` +
          `<button style="position:absolute;left:0;top:20px">Upper second</button>` +
          `</div>`,
      ),
    ),
  },
  {
    name: "focus.trapBroken",
    keys: ["focus.trapBroken"],
    dialog: true,
    html: doc(
      main(`<button style="position:absolute;left:16px;top:16px">Outside first</button>`) +
        `<div role="dialog" aria-modal="true" aria-label="Dialog" style="position:fixed;left:300px;top:200px;background:#fff;border:1px solid #767676;padding:16px"><button>Inside</button></div>`,
    ),
  },
  {
    name: "zoom200",
    keys: ["zoom200.issues"],
    html: doc(main(`<div style="width:700px;height:20px;background:#eee">Wide box</div>`)),
  },
  {
    name: "zoom400",
    keys: ["zoom400.issues"],
    row: { id: "fixture-z400", W: 320, H: 256, dsf: 1, input: "M", zoom: 400 },
    html: doc(main(`<div style="width:500px;height:20px;background:#eee">Wide box</div>`)),
  },
  {
    name: "zoom.pinchBlocked",
    keys: ["zoom.pinchBlocked"],
    html: doc(main(`<p>Pinch disabled</p>`), "", `<meta name="viewport" content="width=device-width,initial-scale=1,user-scalable=no">`),
  },
  {
    name: "textScale",
    keys: ["textScale.issues"],
    html: doc(main(`<div style="font-size:1rem;width:200px;height:50px;overflow:hidden">Short label here.</div>`)),
  },
  {
    // Text that wraps inside a wide column at the 200% root font: nothing clips, nothing overlaps.
    name: "textScale.wraps",
    keys: [],
    html: doc(main(`<h1>Text scale fixture</h1><p style="font-size:1rem;width:300px">Wraps freely in a wide column, so nothing is cut off at the larger root size.</p>`)),
  },
  {
    name: "textSpacing",
    keys: ["textSpacing.issues"],
    row: { ...FIXTURE_ROW, textSpacing: true },
    html: doc(main(`<div style="width:190px;overflow:hidden;white-space:nowrap">Short label, plain text</div>`)),
  },
  {
    name: "theme.attrMatches",
    keys: ["theme.attrMatches"],
    expectTheme: "dark",
    html: doc(main(`<p>Page is light but dark was expected</p>`)),
  },
  {
    name: "forcedColors.issues",
    keys: ["forcedColors.issues"],
    axis: "forced",
    html: doc(main(`<p style="color:transparent;forced-color-adjust:none">Hidden words: author opted out of forced colours</p>`)),
  },
  {
    name: "safe.notch.ok",
    keys: ["safe.notch.ok"],
    row: NOTCH_ROW,
    html: doc(main(`<p>Notch fixture</p>`) + `<button style="position:fixed;top:0;left:0">Top</button>`),
  },
  {
    // Normal-flow controls clear of the insets at rest and at the scroll end: nothing may fire.
    name: "safe.notch.flowClean",
    keys: [],
    row: NOTCH_ROW,
    html: doc(
      main(`<h1>Notch fixture</h1><button style="margin-top:60px;min-width:48px;min-height:48px">Start</button><div style="height:1200px"></div><button style="min-width:48px;min-height:48px">Finish</button>`),
      "body{padding-bottom:40px}",
    ),
  },
  {
    // A normal-flow control in the top inset at rest: the first control sits under the notch.
    name: "safe.notch.flowTop",
    keys: ["safe.notch.ok"],
    row: NOTCH_ROW,
    html: doc(main(`<button>Top flow</button>`) + `<div style="height:1200px"></div>`),
  },
  {
    name: "reducedMotion",
    keys: ["reducedMotion.animating"],
    html: doc(main(`<div style="width:40px;height:40px;background:#222;animation:spin 2s linear infinite"></div>`), "@keyframes spin{to{transform:rotate(360deg)}}"),
  },
  {
    name: "axe.critical",
    keys: ["axe.critical"],
    html: doc(main(`<img src="data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7" width="10" height="10">`)),
  },
  {
    name: "axe.serious",
    keys: ["axe.serious"],
    html: doc(main(`<h1>Heading</h1><p style="color:#bbb;background:#fff">Low contrast text</p>`)),
  },
  {
    name: "axe.moderate",
    keys: ["axe.moderate"],
    html: doc(`<h1>No landmark</h1><p>Content outside any landmark.</p>`),
  },
  {
    name: "console.errors",
    keys: ["console.errors"],
    html: doc(main(`<p>Logs an error</p>`)) + `<script>console.error("qa fixture error")</script>`,
  },
  {
    name: "console.warnings",
    keys: ["console.warnings"],
    html: doc(main(`<p>Logs a warning</p>`)) + `<script>console.warn("qa fixture warning")</script>`,
  },
  {
    name: "console.warnings browser",
    keys: [],
    html: doc(main(`<h1>Browser notice</h1>`)) + `<script>console.warn("WebGPU is disabled by blocklist")</script>`,
  },
  {
    name: "page.errors",
    keys: ["page.errors"],
    html: doc(main(`<p>Throws</p>`)) + `<script>setTimeout(function(){throw new Error("qa fixture uncaught")},0)</script>`,
  },
  {
    name: "net.failed",
    keys: ["net.failed"],
    html: doc(main(`<p>Requests a missing resource</p>`)) + `<script>fetch("${NET_HOST}/x").catch(function(){})</script>`,
  },
];

const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
};
const engines = arg("engines", "chromium").split(",").map((s) => s.trim());

/** Measures one fixture on a fresh context and returns { failures, record }. */
async function runFixture(browser, fixture) {
  const row = fixture.row ?? FIXTURE_ROW;
  const axis = fixture.axis ?? "none";
  const options = { viewport: { width: row.W, height: row.H }, deviceScaleFactor: row.dsf, colorScheme: "light" };
  if (axis === "forced") options.forcedColors = "active";
  if (axis === "more") options.contrast = "more";
  const context = await browser.newContext(options);
  try {
    const page = await context.newPage();
    const handle = { label: fixture.name, problems: [] };
    trackPage(page, handle);
    await page.route(`${NET_HOST}/**`, (route) => route.abort());
    await page.setContent(fixture.html, { waitUntil: "load" });
    await nextFrames(page);
    const m = await measureState(page, {
      row,
      fit: fixture.fit ?? false,
      dialog: fixture.dialog ?? false,
      handles: [handle],
      axis,
      expectTheme: fixture.expectTheme ?? "light",
    });
    const record = { fit: fixture.fit ?? false, metrics: m.metrics, details: m.details };
    return { failures: validateRecord(record), record };
  } finally {
    await context.close().catch(() => {});
  }
}

const covered = new Set(FIXTURES.flatMap((f) => f.keys));
const missing = Object.keys(THRESHOLDS).filter((key) => !covered.has(key));
let bad = missing.map((key) => `no fixture for threshold ${key}`);
let checks = 0;

for (const engine of engines) {
  let browser = await launchEngine(engine);
  console.log(`== ${engine}`);
  for (const fixture of FIXTURES) {
    // A crashed page or browser gets one retry on a fresh browser; a second failure is reported as MISS.
    let outcome;
    try {
      outcome = await runFixture(browser, fixture);
    } catch {
      await browser.close().catch(() => {});
      browser = await launchEngine(engine);
      try {
        outcome = await runFixture(browser, fixture);
      } catch (err) {
        outcome = { error: err };
      }
    }
    const label = fixture.name.padEnd(22);
    if (outcome.error) {
      const why = String(outcome.error.message ?? outcome.error).split("\n")[0];
      for (const key of fixture.keys.length ? fixture.keys : ["clean"]) {
        checks++;
        bad.push(`${engine} ${fixture.name}: ${key} not measured (fixture errored: ${why})`);
        console.log(`MISS  ${label} ${key} not measured (fixture errored: ${why})`);
      }
      continue;
    }
    const { failures, record } = outcome;
    if (fixture.keys.length === 0) {
      checks++;
      if (failures.length === 0) console.log(`ok    ${label} clean: 0 failures`);
      else {
        const where = Object.entries(record.details)
          .filter(([k]) => failures.some((f) => f.startsWith(`${k}=`)) || (k === "axe.rules" && failures.some((f) => f.startsWith("axe."))))
          .map(([k, v]) => `${k}: ${v.slice(0, 3).map((x) => (typeof x === "string" ? x : JSON.stringify(x))).join(" | ")}`);
        bad.push(`${engine} ${fixture.name}: clean fixture reports ${failures.join("; ")}`);
        console.log(`FAIL  ${label} clean fixture reports ${failures.join("; ")}`);
        for (const w of where) console.log(`      ${w}`);
      }
      continue;
    }
    for (const key of fixture.keys) {
      checks++;
      const hit = failures.find((f) => f.startsWith(`${key}=`));
      const others = failures.filter((f) => !f.startsWith(`${key}=`));
      if (hit) console.log(`ok    ${label} ${hit}${others.length ? `  (also ${others.length})` : ""}`);
      else {
        bad.push(`${engine} ${fixture.name}: ${key} did not fire (value ${JSON.stringify(record.metrics[key])}, details ${JSON.stringify(record.details[key] ?? null)})`);
        console.log(`MISS  ${label} ${key} did not fire (value ${JSON.stringify(record.metrics[key])})`);
      }
    }
  }
}
await runCleanups();

for (const line of bad) console.log(`problem: ${line}`);
console.log(`${checks - bad.length}/${checks} checks pass; ${bad.length === 0 ? "every detector fires, clean fixtures are clean" : `${bad.length} problems`}`);
process.exitCode = bad.length === 0 ? 0 : 1;
