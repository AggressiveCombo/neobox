// Map editor: draw a map on a canvas, tune its objects in the inspector, test-play
// it, and open or save it (file, built-in map, library or pasted code). Pointers
// and keys are handled by editor/controller.ts; this screen lays out the controls.

import { errorText, listMine, uploadMap, type LibraryMap, type Visibility } from "../../account";
import type { AppCtx, ScreenFactory } from "../../ctx";
import { EditorController, type Tool } from "../../editor/controller";
import { downloadMap, mapText, parseMap, readMapFile } from "../../editor/io";
import { renderInspector } from "../../editor/inspector";
import { emptyDoc, type Obj } from "../../editor/schema";
import { startTestPlay, type TestPlay } from "../../editor/testplay";
import type { Screen } from "../../state";
import { h } from "../dom";
import { VISIBILITY_LABELS, mapCode } from "../map-list";
import { signInPrompt } from "./account";

const TOOLS: { tool: Tool; label: string }[] = [
  { tool: "select", label: "Select" },
  { tool: "rect", label: "Box" },
  { tool: "circle", label: "Circle" },
  { tool: "poly", label: "Polygon" },
  { tool: "joint", label: "Joint" },
  { tool: "spawn", label: "Spawn" },
  { tool: "turret", label: "Turret" },
  { tool: "grapple", label: "Grapple" },
  { tool: "cap", label: "Capture" },
];
const VISIBILITIES: Visibility[] = ["public", "unlisted", "private"];

function errText(err: unknown): string {
  return errorText(err);
}

export const editorScreen: ScreenFactory = (ctx) => {
  const root = h("div", { class: "screen editor" });
  let origin: Screen = "menu";
  let originKnown = false;
  let destroyed = false;
  let starting = false;
  let testing: TestPlay | null = null;
  let shownDoc: Obj | null = null;
  let shownSel = "";

  // Canvas and the controls around it.
  const canvas = h("canvas", { class: "editor-canvas", "aria-label": "Map canvas" });
  const stage = h("div", { class: "editor-stage" }, canvas);
  const ctrl = new EditorController(canvas, () => refresh());
  const observer = new ResizeObserver(() => {
    if (stage.isConnected) ctrl.resize();
  });
  observer.observe(stage);

  const toolButtons = new Map<Tool, HTMLButtonElement>();
  const toolRow = h(
    "div",
    { class: "editor-tools", role: "toolbar", "aria-label": "Tools" },
    TOOLS.map(({ tool, label }) => {
      const btn = h("button", { type: "button", class: "editor-tool", onclick: () => ctrl.setTool(tool) }, label);
      toolButtons.set(tool, btn);
      return btn;
    }),
  );

  const undoBtn = h("button", { type: "button", onclick: () => ctrl.undo() }, "Undo");
  const redoBtn = h("button", { type: "button", onclick: () => ctrl.redo() }, "Redo");
  const deleteBtn = h("button", { type: "button", onclick: () => ctrl.removeSelection() }, "Delete");
  const fitBtn = h("button", { type: "button", onclick: () => ctrl.fit() }, "Fit");
  const testBtn = h("button", { type: "button", class: "primary", onclick: () => void playTest() }, "Test play");
  const actions = h("div", { class: "editor-actions" }, undoBtn, redoBtn, deleteBtn, fitBtn, testBtn);

  const hintEl = h("p", { class: "editor-hint", role: "status", "aria-live": "polite" });
  const inspectorHost = h("div", { class: "editor-inspector" });

  const menuBtn = h("button", { type: "button", class: "editor-menu-toggle", "aria-expanded": "false", onclick: () => toggleMenu() }, "Menu");
  const topbar = h(
    "div",
    { class: "editor-top" },
    h("button", { type: "button", onclick: () => exit() }, "Back"),
    h("span", { class: "editor-title" }, "Editor"),
    menuBtn,
  );

  // Menu sheet.
  const builtinList = h("div", { class: "editor-list" });
  const mineList = h("div", { class: "editor-list" });
  const codeBox = h("textarea", { class: "editor-code", readonly: "", rows: 3, "aria-label": "Map code" });
  const pasteInput = h("input", { type: "text", placeholder: "Paste a map code", "aria-label": "Map code to open" });
  const fileInput = h("input", { type: "file", accept: ".json,application/json", "aria-label": "Open map file" });
  const saveBox = h("div", { class: "editor-save" });
  const menuBody = h(
    "div",
    { class: "editor-menu-body" },
    h("section", null, h("h2", null, "Map"),
      h("div", { class: "editor-row" },
        h("button", { type: "button", onclick: () => newMap() }, "New map"),
        h("button", { type: "button", onclick: () => downloadCurrent() }, "Download"),
      ),
      h("label", { class: "editor-field" }, h("span", null, "Open a file"), fileInput),
    ),
    h("section", null, h("h2", null, "Built-in maps"), builtinList),
    h("section", null, h("h2", null, "My maps"), mineList),
    h("section", null, h("h2", null, "Paste code"),
      h("div", { class: "editor-row" }, pasteInput, h("button", { type: "button", onclick: () => void openPasted() }, "Open")),
    ),
    h("section", null, h("h2", null, "Share code"), codeBox,
      h("div", { class: "editor-row" }, h("button", { type: "button", onclick: () => void copyCode() }, "Copy code")),
    ),
    h("section", null, h("h2", null, "Save to library"), saveBox),
  );
  const menu = h(
    "div",
    { class: "editor-menu" },
    h("div", { class: "editor-top" },
      h("span", { class: "editor-title" }, "Map"),
      h("button", { type: "button", onclick: () => toggleMenu(false) }, "Close"),
    ),
    menuBody,
  );
  menu.hidden = true;

  fileInput.addEventListener("change", () => {
    const file = fileInput.files?.[0];
    fileInput.value = "";
    if (!file) return;
    void readMapFile(file)
      .then((doc) => replaceMap(doc, file.name))
      .catch((err: unknown) => ctx.toast(errText(err), "error"));
  });

  const editorNodes: Node[] = [topbar, stage, toolRow, actions, hintEl, inspectorHost, menu];
  root.replaceChildren(...editorNodes);

  // Shows the current selection's inspector. Focus inside the inspector with an
  // unchanged selection keeps the inspector as it is, so typing is not interrupted.
  function refreshInspector(): void {
    const doc = ctrl.doc;
    const sel = ctrl.sel.map((r) => JSON.stringify(r)).join("|");
    if (doc === shownDoc && sel === shownSel) return;
    const sameSel = sel === shownSel;
    shownDoc = doc;
    if (sameSel && inspectorHost.contains(document.activeElement)) return;
    shownSel = sel;
    inspectorHost.replaceChildren(
      renderInspector({
        doc,
        sel: ctrl.sel,
        commit: (next) => ctrl.commit(next),
        remove: () => ctrl.removeSelection(),
      }),
    );
  }

  function refresh(): void {
    for (const [tool, btn] of toolButtons) btn.setAttribute("aria-pressed", String(tool === ctrl.tool));
    undoBtn.disabled = !ctrl.canUndo;
    redoBtn.disabled = !ctrl.canRedo;
    deleteBtn.disabled = ctrl.sel.length === 0;
    hintEl.textContent = ctrl.message || ctrl.hint;
    refreshInspector();
  }

  function exit(): void {
    ctx.store.set({ screen: origin });
  }

  function toggleMenu(show?: boolean): void {
    const on = show ?? menu.hidden;
    menu.hidden = !on;
    menuBtn.setAttribute("aria-expanded", String(on));
    if (on) refreshMenu();
  }

  function isEmptyMap(): boolean {
    return JSON.stringify(ctrl.doc) === JSON.stringify(emptyDoc());
  }

  /** Replace the open map; asks first when the current map is not empty. */
  function replaceMap(doc: Obj, label: string): void {
    if (!isEmptyMap() && !window.confirm("Replace the current map?")) return;
    ctrl.load(doc);
    toggleMenu(false);
    ctx.toast(`Opened ${label}`);
  }

  function newMap(): void {
    if (!isEmptyMap() && !window.confirm("Start a new map? The current map is replaced.")) return;
    ctrl.load(emptyDoc());
    toggleMenu(false);
  }

  function downloadCurrent(): void {
    downloadMap(ctrl.doc);
  }

  async function decode(code: string): Promise<Obj> {
    const eng = await ctx.engine();
    return parseMap(eng.mapDecode(code.trim()));
  }

  async function openCode(code: string, label: string): Promise<void> {
    try {
      replaceMap(await decode(code), label);
    } catch (err) {
      ctx.toast(errText(err), "error");
    }
  }

  function openPasted(): Promise<void> {
    return openCode(pasteInput.value, "pasted code");
  }

  async function copyCode(): Promise<void> {
    codeBox.select();
    try {
      await navigator.clipboard.writeText(codeBox.value);
      ctx.toast("Code copied");
    } catch {
      ctx.toast("Select the code and copy it by hand");
    }
  }

  function refreshCode(): void {
    try {
      codeBox.value = ctx.wasm.mapEncode(mapText(ctrl.doc));
    } catch (err) {
      codeBox.value = "";
      ctx.toast(errText(err), "error");
    }
  }

  async function showBuiltins(): Promise<void> {
    builtinList.replaceChildren(h("p", { class: "status" }, "Loading maps…"));
    try {
      const maps = await ctx.maps();
      builtinList.replaceChildren(
        ...maps.map((m) =>
          h("button", { type: "button", class: "editor-item", onclick: () => void openCode(m.code, m.name) }, m.name),
        ),
      );
    } catch (err) {
      builtinList.replaceChildren(h("p", { class: "status error" }, errText(err)));
    }
  }

  function openLibraryMap(m: LibraryMap): void {
    mapCode(m.id)
      .then((code) => openCode(code, m.name))
      .catch((err: unknown) => ctx.toast(errText(err), "error"));
  }

  async function showMine(): Promise<void> {
    if (!ctx.store.state.account) {
      mineList.replaceChildren(signInPrompt(ctx, "Sign in to open your saved maps."));
      return;
    }
    mineList.replaceChildren(h("p", { class: "status" }, "Loading your maps…"));
    try {
      const maps = await listMine();
      mineList.replaceChildren(
        ...(maps.length
          ? maps.map((m) =>
              h("button", { type: "button", class: "editor-item", onclick: () => openLibraryMap(m) }, `${m.name} · ${VISIBILITY_LABELS[m.visibility]}`),
            )
          : [h("p", { class: "status" }, "No saved maps yet.")]),
      );
    } catch (err) {
      mineList.replaceChildren(h("p", { class: "status error" }, errText(err)));
    }
  }

  function showSave(): void {
    if (!ctx.store.state.account) {
      saveBox.replaceChildren(signInPrompt(ctx, "Sign in to save maps to your library."));
      return;
    }
    const name = h("input", { type: "text", placeholder: "Map name", maxlength: 40, "aria-label": "Map name" });
    const visibility = h(
      "select",
      { "aria-label": "Visibility" },
      VISIBILITIES.map((v) => h("option", { value: v }, VISIBILITY_LABELS[v])),
    );
    const note = h("p", { class: "status" }, "Public maps appear in the library after approval.");
    const save = h("button", { type: "button", class: "primary" }, "Save to library");
    save.addEventListener("click", () => {
      void saveToLibrary(name.value, visibility.value as Visibility, save);
    });
    saveBox.replaceChildren(
      h("label", { class: "editor-field" }, h("span", null, "Name"), name),
      h("label", { class: "editor-field" }, h("span", null, "Visibility"), visibility),
      note,
      save,
    );
  }

  async function saveToLibrary(name: string, visibility: Visibility, btn: HTMLButtonElement): Promise<void> {
    const title = name.trim();
    if (!title) {
      ctx.toast("Give the map a name", "error");
      return;
    }
    let code: string;
    try {
      code = ctx.wasm.mapEncode(mapText(ctrl.doc));
    } catch (err) {
      ctx.toast(errText(err), "error");
      return;
    }
    btn.disabled = true;
    try {
      await uploadMap({ name: title, code, visibility });
      ctx.toast("Saved to your library");
      void showMine();
    } catch (err) {
      ctx.toast(errText(err), "error");
    } finally {
      btn.disabled = false;
    }
  }

  function refreshMenu(): void {
    refreshCode();
    void showBuiltins();
    void showMine();
    showSave();
  }

  /** Test play replaces the editor layout with the game's touch layer. */
  async function playTest(): Promise<void> {
    if (testing || starting || destroyed) return;
    starting = true;
    let started: TestPlay;
    try {
      started = await startTestPlay(ctx, ctrl.doc, (failure) => stopTest(failure));
    } catch (err) {
      ctx.toast(`Could not start test play: ${errText(err)}`, "error");
      return;
    } finally {
      starting = false;
    }
    if (destroyed) {
      started.destroy();
      return;
    }
    testing = started;
    toggleMenu(false);
    ctrl.pause(true);
    root.className = "offline playing";
    root.replaceChildren(...started.nodes);
  }

  /** Back to editing. `failure` is set when the game stopped on an error. */
  function stopTest(failure?: string): void {
    const t = testing;
    if (!t) return;
    testing = null;
    t.destroy();
    root.className = "screen editor";
    root.replaceChildren(...editorNodes);
    ctrl.pause(false);
    ctrl.resize();
    if (failure) ctx.toast(`Test play stopped: ${failure}`, "error");
  }

  refresh();

  return {
    el: root,
    update(_, prev) {
      if (!originKnown) {
        origin = prev.screen;
        originKnown = true;
      }
    },
    destroy() {
      destroyed = true;
      observer.disconnect();
      if (testing) {
        testing.destroy();
        testing = null;
      }
      ctrl.destroy();
    },
  };
};
