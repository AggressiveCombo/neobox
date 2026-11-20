// Editor parity instrument: the product's circle and box drags against the original's, world unit for world unit.
// The fixture (qa/fixtures/editor-parity.json) holds the original's values, pixel-measured in its editor (same 13 world
// drags for both tools; the box values come from its panel where it shows them). Each drag is a pointer path in world
// units on the product's own view (frame width from the map's set "3", default 30; centred on the arena or the origin);
// the view is moved by a 15 x 10 unit pan first, the original's pan gesture (right-drag, or Ctrl+drag under any tool).
//
// Rules checked per drag (TOL world units, fixture.tolerance): the body's centre and radius (circle), or its corners
// (box), are within TOL of the original's; one shape per drag. Pan cases also check a Ctrl+drag under the Select or
// Box tool creates no body and leaves the view where the pan puts it (a circle drawn after the pan lands on the
// fixture's world point).
//
// Usage:  cd client && NEOBOX_DIST=<dist> QA_OUT=<dir> QA_ENGINES=chromium node qa/editor-parity.mjs
// Control: the same run on a build of fda49ea^ (8afe6db, old geometry: snap 1, boxes under 1 unit reject) must FAIL.

import { readFileSync } from "node:fs";
import path from "node:path";
import { Results, QA_DIR, launchEngine, runCleanups, selectedEngines, startServer, writeIndex } from "./lib-qa.mjs";

const lib = await import("../e2e/lib.mjs");
const { sleep } = lib;

const FIXTURE = JSON.parse(readFileSync(path.join(QA_DIR, "fixtures/editor-parity.json"), "utf8"));
const TOL = FIXTURE.tolerance;
const PAN = { x: 15, y: 10 };
const DRAFT = "neobox.editor.draft";

const CASES = [
  { id: "parity.circle", panTool: "Circle", pan: "right", tool: "Circle", drags: FIXTURE.circles },
  { id: "parity.box", panTool: "Box", pan: "right", tool: "Box", drags: FIXTURE.boxes },
  { id: "pan.ctrl.box", panTool: "Box", pan: "ctrl", tool: "Box", drags: FIXTURE.boxes },
  { id: "pan.ctrl.select", panTool: "Select", pan: "ctrl", tool: "Circle", drags: FIXTURE.circles.slice(0, 1) },
  { id: "pan.right.box", panTool: "Box", pan: "right", tool: "Box", drags: FIXTURE.boxes },
  { id: "pan.right.select", panTool: "Select", pan: "right", tool: "Circle", drags: FIXTURE.circles.slice(0, 1) },
];

const engines = selectedEngines();

/** Pixel position of a world point under the view centred at (vx, vy) with `scale` px per unit, canvas origin (ox, oy). */
const toPx = (v, [X, Y]) => [v.ox + (X - v.vx) * v.scale, v.oy + (Y - v.vy) * v.scale];

/** The view after a PAN pan from the product's default framing (draft set "3" frame width, arena "15"/"16"). */
function viewAfterPan(set, box) {
  const frameW = set["3"] ?? 30;
  const frameH = frameW / 1.6;
  const arenaW = set["15"] ?? 0;
  const arenaH = set["16"] ?? 0;
  const clamp = (c, size, arena) => (arena < size ? arena / 2 : Math.min(Math.max(c, size / 2), arena - size / 2));
  const cx = clamp(arenaW / 2, frameW, arenaW);
  const cy = clamp(arenaH / 2, frameH, arenaH);
  const scale = Math.min(200, Math.max(0.02, box.width / frameW));
  const dx = Math.round(PAN.x * scale);
  const dy = Math.round(PAN.y * scale);
  return { scale, ox: box.x + box.width / 2, oy: box.y + box.height / 2, vx: cx + dx / scale, vy: cy + dy / scale, dx, dy };
}

/** The product's body for the last drag: its centre and radius (circle) or its box corners (box). */
function measured(body, kind) {
  if (kind === "circle") {
    const sh = body?.s?.[0] ?? {};
    return { centre: [(body?.["2"] ?? 0) + (sh["2"] ?? 0), (body?.["3"] ?? 0) + (sh["3"] ?? 0)], r: sh["9"], shapes: body?.s?.length ?? 0 };
  }
  const xs = [];
  const ys = [];
  for (const sh of body?.s ?? []) {
    for (let k = 0; k < (sh.p ?? []).length; k += 2) {
      xs.push((body["2"] ?? 0) + (sh["2"] ?? 0) + sh.p[k]);
      ys.push((body["3"] ?? 0) + (sh["3"] ?? 0) + sh.p[k + 1]);
    }
  }
  return { rect: { x0: Math.min(...xs), x1: Math.max(...xs), y0: Math.min(...ys), y1: Math.max(...ys) }, shapes: body?.s?.length ?? 0 };
}

/** Errors of one drag against its fixture row; each entry is within TOL or it is a failure. */
function compare(kind, got, want) {
  if (kind === "circle") {
    const err = { cx: got.centre[0] - want.centre[0], cy: got.centre[1] - want.centre[1], r: got.r - want.r };
    return { err, ok: Math.abs(err.cx) <= TOL && Math.abs(err.cy) <= TOL && Math.abs(err.r) <= TOL && got.shapes === 1 };
  }
  const err = { x0: got.rect.x0 - want.x0, x1: got.rect.x1 - want.x1, y0: got.rect.y0 - want.y0, y1: got.rect.y1 - want.y1 };
  return { err, ok: Object.values(err).every((e) => Math.abs(e) <= TOL) && got.shapes === 1 };
}

const round = (v) => (typeof v === "number" ? +v.toFixed(3) : v);
const roundAll = (o) => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, round(v)]));

for (const engine of engines) {
  const browser = await launchEngine(engine);
  const results = new Results("editor-parity", engine);
  const srv = await startServer();
  for (const c of CASES) {
    const kind = c.tool === "Box" ? "box" : "circle";
    await results.case(
      c.id,
      async (s) => {
        const { page } = await s.open(c.id);
        await page.goto(s.base);
        await lib.menuName(page).waitFor();
        await lib.navTo(page, "Map editor");
        const canvas = page.locator("canvas.editor-canvas");
        await canvas.waitFor({ state: "visible" });
        await sleep(800);
        const box = await canvas.boundingBox();
        const draft = () => page.evaluate((key) => JSON.parse(localStorage.getItem(key) ?? "{}"), DRAFT);
        const bodies = async () => (await draft()).b ?? [];

        await page.getByRole("button", { name: c.panTool, exact: true }).click();
        const set = (await draft()).set ?? {};
        const v = viewAfterPan(set, box);
        const ox = v.ox;
        const oy = v.oy;
        const before0 = (await bodies()).length;
        if (c.pan === "right") {
          await page.mouse.move(ox, oy);
          await page.mouse.down({ button: "right" });
          await page.mouse.move(ox - v.dx, oy - v.dy, { steps: 4 });
          await page.mouse.up({ button: "right" });
        } else {
          await page.keyboard.down("Control");
          await page.mouse.move(ox, oy);
          await page.mouse.down();
          await page.mouse.move(ox - v.dx, oy - v.dy, { steps: 4 });
          await page.mouse.up();
          await page.keyboard.up("Control");
        }
        await sleep(300);
        const panned = (await bodies()).length;
        if (panned !== before0) return { pass: false, detail: `a ${c.pan} pan under ${c.panTool} created ${panned - before0} body(ies)` };

        await page.getByRole("button", { name: c.tool, exact: true }).click();
        const rows = [];
        for (const d of c.drags) {
          const n = (await bodies()).length;
          const [sx, sy] = toPx(v, d.s);
          const [ex, ey] = toPx(v, d.p);
          await page.mouse.move(sx, sy);
          await page.mouse.down();
          await page.mouse.move(ex, ey, { steps: 6 });
          await page.mouse.up();
          await page.waitForFunction(
            ([key, want]) => (JSON.parse(localStorage.getItem(key) ?? "{}").b ?? []).length === want,
            [DRAFT, n + 1],
            { timeout: 5000 },
          ).catch(() => {});
          const body = (await bodies()).at(-1);
          const got = measured(body, kind);
          const want = kind === "circle" ? { centre: d.centre, r: d.r } : d.rect;
          const { err, ok } = compare(kind, got, want);
          rows.push({ name: d.name, ok, got: roundAll(kind === "circle" ? { cx: got.centre[0], cy: got.centre[1], r: got.r } : got.rect), want: kind === "circle" ? { cx: d.centre[0], cy: d.centre[1], r: d.r } : d.rect, err: roundAll(err), shapes: got.shapes });
        }
        const bad = rows.filter((r) => !r.ok);
        const worst = Math.max(...rows.flatMap((r) => Object.values(r.err).map(Math.abs)));
        return {
          pass: bad.length === 0,
          metrics: { [`editorParity.${c.id}.drags`]: rows.length, [`editorParity.${c.id}.maxErr`]: round(worst) },
          detail: bad.length ? `${bad.length}/${rows.length} off tolerance ${TOL}: ${bad.map((r) => `${r.name} err=${JSON.stringify(r.err)}`).join("; ")}` : `${rows.length}/${rows.length} within ${TOL} (max err ${round(worst)})`,
          evidence: [],
          rows,
        };
      },
      { browser, base: srv.base },
    );
  }
  await srv.stop();
  results.save();
  await browser.close?.();
}
writeIndex();
await runCleanups();
