// Map editor: draw a map on a canvas, tune its objects in the inspector, test-play
// it, and open or save it (file, built-in map, library or pasted code). Pointers
// and keys are handled by editor/controller.ts; this screen lays out the controls.
// Opened from a room (store.editorForRoom), it edits the room's map and can send
// the result back to the room.

import { errorText, listFavourites, listMine, updateMap, uploadMap, type LibraryMap, type Visibility } from "../../account";
import type { ScreenFactory } from "../../ctx";
import { EditorController, lagVerdict, type Tool } from "../../editor/controller";
import { downloadMap, mapText, parseMap, readMapFile } from "../../editor/io";
import { renderInspector } from "../../editor/inspector";
import { emptyDoc, hexColor, type Obj } from "../../editor/schema";
import { startTestPlay, type TestPlay } from "../../editor/testplay";
import type { Screen } from "../../state";
import { h } from "../dom";
import { field, openModal, seg, uid } from "../kit";
import { VISIBILITY_LABELS, mapCode } from "../map-list";
import { signInPrompt } from "./account";

const TOOLS: { tool: Tool; label: string; key: string; icon: string }[] = [
  { tool: "select", label: "Select", key: "Q", icon: "select" },
  { tool: "rect", label: "Box", key: "W", icon: "box" },
  { tool: "circle", label: "Circle", key: "E", icon: "circle" },
  { tool: "poly", label: "Polygon", key: "R", icon: "poly" },
  { tool: "joint", label: "Joint", key: "J", icon: "joint" },
  { tool: "spawn", label: "Spawn", key: "T", icon: "spawn" },
  { tool: "turret", label: "Turret", key: "I", icon: "turret" },
  { tool: "grapple", label: "Grapple", key: "G", icon: "grapple" },
  { tool: "cap", label: "Capture", key: "Y", icon: "capture" },
  { tool: "fill", label: "Fill", key: "U", icon: "fill" },
];
const VISIBILITIES: Visibility[] = ["public", "unlisted", "private"];

/** Line icons on a 24 grid, stroke in currentColor. Constant markup, never user input. */
const ICON_PATHS: Record<string, string> = {
  select: '<path d="M5 3l13 8-6 1.5L9.5 19z"/>',
  box: '<rect x="4" y="6" width="16" height="12"/>',
  circle: '<circle cx="12" cy="12" r="7"/>',
  poly: '<path d="M5 19L4 9l8-5 8 6-3 9z"/>',
  joint: '<path d="M7 12h10"/><rect x="2.5" y="9.5" width="5" height="5"/><rect x="16.5" y="9.5" width="5" height="5"/>',
  spawn: '<path d="M6 21V4"/><path d="M6 5h11l-3 4 3 4H6"/>',
  turret: '<rect x="7" y="12" width="10" height="6"/><path d="M12 12V6h6"/>',
  grapple: '<path d="M12 4v8"/><path d="M6 12a6 6 0 0 0 12 0"/>',
  capture: '<rect x="4" y="4" width="16" height="16"/><path d="M9 9h6v6H9z"/>',
  fill: '<path d="M5 12l7-7 7 7-7 7z"/><path d="M19 15c0 1.5-1 3-2 3"/>',
  undo: '<path d="M9 14L4 9l5-5"/><path d="M4 9h10a6 6 0 0 1 0 12h-3"/>',
  redo: '<path d="M15 14l5-5-5-5"/><path d="M20 9H10a6 6 0 0 0 0 12h3"/>',
  back: '<path d="M15 5l-7 7 7 7"/>',
  menu: '<path d="M4 7h16M4 12h16M4 17h16"/>',
  zoomIn: '<circle cx="11" cy="11" r="6"/><path d="M8 11h6M11 8v6M16 16l4 4"/>',
  zoomOut: '<circle cx="11" cy="11" r="6"/><path d="M8 11h6M16 16l4 4"/>',
  reset: '<path d="M4 12a8 8 0 1 0 2.4-5.7"/><path d="M4 4v4h4"/>',
  sheet: '<path d="M4 15l8-7 8 7"/>',
  close: '<path d="M6 6l12 12M18 6L6 18"/>',
};

function icon(name: string): SVGElement {
  const t = document.createElement("template");
  t.innerHTML = `<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">${ICON_PATHS[name] ?? ""}</svg>`;
  return t.content.firstElementChild as SVGElement;
}

/** A square icon-only button; `label` is its accessible name. */
function iconButton(name: string, label: string, onclick: () => void): HTMLButtonElement {
  return h("button", { type: "button", class: "icon", "aria-label": label, title: label, onclick }, icon(name));
}

export const editorScreen: ScreenFactory = (ctx) => {
  const root = h("main", { class: "screen editor" });
  // Room mode: the editor was opened from a room and edits that room's map.
  const inRoom = ctx.store.state.editorForRoom;
  let origin: Screen = "menu";
  let originKnown = false;
  let destroyed = false;
  let starting = false;
  let testing: TestPlay | null = null;
  let shownDoc: Obj | null = null;
  let shownSel = "";
  /** Name of the map on screen, sent to the room by "Use in room". */
  let mapName: string | null = null;
  /** The player's own library map on screen (Save overwrites it), or null. */
  let libraryMap: LibraryMap | null = null;

  // Viewport: the canvas, the scope bar and the lag verdict over it.
  const canvas = h("canvas", { class: "editor-canvas", "aria-label": "Map canvas" });
  const lagEl = h("p", { class: "editor-lag", role: "status" });
  const scopeText = h("span", {});
  const scopeBar = h("div", { class: "editor-scope", role: "status" }, scopeText, h("button", { type: "button", onclick: () => ctrl.leaveScope() }, "Leave body"));
  scopeBar.hidden = true;
  const viewport = h("div", { class: "editor-viewport" }, canvas, scopeBar, lagEl);
  const ctrl = new EditorController(canvas, () => refresh(), !inRoom);
  const observer = new ResizeObserver(() => {
    if (viewport.isConnected) ctrl.resize();
  });
  observer.observe(viewport);

  const toolButtons = new Map<Tool, HTMLButtonElement>();
  const toolRail = h(
    "div",
    { class: "editor-tools", role: "toolbar", "aria-label": "Tools" },
    TOOLS.map(({ tool, label, key, icon: name }) => {
      const btn = h(
        "button",
        { type: "button", class: "editor-tool", "aria-label": label, "aria-keyshortcuts": key, title: `${label} (${key})`, onclick: () => ctrl.setTool(tool) },
        icon(name),
        h("span", { class: "editor-tool-name" }, label),
        h("span", { class: "key", "aria-hidden": "true" }, key),
      );
      toolButtons.set(tool, btn);
      return btn;
    }),
  );

  const undoBtn = iconButton("undo", "Undo", () => ctrl.undo());
  const redoBtn = iconButton("redo", "Redo", () => ctrl.redo());
  const mergeBtn = h("button", { type: "button", class: "quiet", title: "Join the selected bodies into one", onclick: () => ctrl.mergeSelected() }, "Merge shapes");
  const zoomOutBtn = iconButton("zoomOut", "Zoom out", () => ctrl.zoomBy(0.8));
  const zoomInBtn = iconButton("zoomIn", "Zoom in", () => ctrl.zoomBy(1.25));
  const resetZoomBtn = iconButton("reset", "Reset zoom", () => ctrl.resetZoom());
  const colourInput = h("input", {
    type: "color",
    class: "editor-colour",
    title: "Fill colour",
    "aria-label": "Fill colour",
    value: `#${ctrl.fillColour.toString(16).padStart(6, "0")}`,
  });
  colourInput.addEventListener("input", () => ctrl.setFillColour(hexColor(colourInput.value)));
  const useRoomBtn = h("button", { type: "button", class: "primary", onclick: () => useInRoom() }, "Use in room");
  useRoomBtn.hidden = !inRoom;
  // Test play is the screen's one yellow action; in room mode "Use in room" takes that role.
  const testBtn = h("button", { type: "button", class: inRoom ? "" : "primary", onclick: () => void playTest() }, "Test play");

  const nameInput = h("input", { type: "text", class: "editor-name", placeholder: "Untitled map", maxlength: 40, "aria-label": "Editor map name" });
  nameInput.addEventListener("change", () => {
    mapName = nameInput.value.trim() || null;
  });

  const menuId = uid("editor-menu");
  const menuBtn = h(
    "button",
    { type: "button", class: "editor-menu-toggle", "aria-label": "Menu", "aria-expanded": "false", "aria-controls": menuId, onclick: () => toggleMenu() },
    icon("menu"),
    h("span", { class: "editor-label" }, "Menu"),
  );
  const topbar = h(
    "header",
    { class: "editor-top" },
    h("button", { type: "button", class: "quiet", "aria-label": "Back", onclick: () => exit() }, icon("back"), h("span", { class: "editor-label" }, "Back")),
    h("h1", { class: "editor-sr" }, "Map editor"),
    nameInput,
    h("div", { class: "editor-top-tools" }, undoBtn, redoBtn, useRoomBtn, testBtn, menuBtn),
  );

  // Footer under the canvas: the hint, then the view controls. The inspector
  // toggle shows on phones and narrow windows only, where the inspector is a sheet.
  const hintEl = h("p", { class: "editor-hint", role: "status", "aria-live": "polite" });
  const inspectorId = uid("editor-inspector");
  const sideToggleLabel = h("span", { class: "editor-label" }, "Map settings");
  const sideToggle = h(
    "button",
    { type: "button", class: "editor-side-toggle", "aria-expanded": "false", "aria-controls": inspectorId, onclick: () => setSide(sideEl.dataset.open !== "true") },
    icon("sheet"),
    sideToggleLabel,
  );
  const foot = h(
    "div",
    { class: "editor-foot" },
    hintEl,
    h("div", { class: "editor-view", role: "group", "aria-label": "View" }, zoomOutBtn, zoomInBtn, resetZoomBtn, colourInput, mergeBtn, sideToggle),
  );
  const stage = h("div", { class: "editor-stage" }, viewport, foot);

  // Inspector: a side column on desktop; a sheet on phones and narrow windows.
  const sideTitle = h("span", { class: "editor-side-title" }, "Map settings");
  const inspectorHost = h("div", { class: "editor-side-body", id: inspectorId });
  const sideEl = h(
    "aside",
    { class: "editor-side", "aria-label": "Inspector", "data-open": "false" },
    h(
      "div",
      { class: "editor-side-head" },
      sideTitle,
      h("button", { type: "button", class: "icon", "aria-label": "Close inspector", onclick: () => setSide(false) }, icon("close")),
    ),
    inspectorHost,
  );

  // Menu: over the editor (a panel on desktop, full screen on phones).
  const builtinList = h("div", { class: "editor-list" });
  const mineList = h("div", { class: "editor-list" });
  const favList = h("div", { class: "editor-list" });
  const codeBox = h("textarea", { class: "editor-code", readonly: "", rows: 3, "aria-label": "Map code" });
  const pasteInput = h("input", { type: "text", placeholder: "Paste a map code", "aria-label": "Map code to open" });
  const fileInput = h("input", { type: "file", accept: ".json,application/json", "aria-label": "Open map file" });
  fileInput.hidden = true;
  const menuClose = h("button", { type: "button", class: "quiet", onclick: () => toggleMenu(false) }, "Close");
  const menu = h(
    "div",
    { class: "editor-menu", id: menuId, role: "dialog", "aria-label": "Map menu" },
    h("div", { class: "editor-menu-head" }, h("h2", null, "Map"), menuClose),
    h(
      "div",
      { class: "editor-menu-body" },
      h(
        "section",
        { class: "editor-group" },
        h("h3", null, "File"),
        h(
          "div",
          { class: "editor-buttons" },
          h("button", { type: "button", onclick: () => { toggleMenu(false); openSaveDialog(); } }, "Save to library"),
          h("button", { type: "button", onclick: () => fileInput.click() }, "Load file"),
          h("button", { type: "button", onclick: () => downloadMap(ctrl.doc) }, "Download"),
          h("button", { type: "button", onclick: () => void copyCode() }, "Copy map code"),
          h("button", { type: "button", onclick: () => newMap() }, "New map"),
        ),
        fileInput,
      ),
      h("section", { class: "editor-group" }, h("h3", null, "Built-in maps"), builtinList),
      h("section", { class: "editor-group" }, h("h3", null, "My maps"), mineList),
      h("section", { class: "editor-group" }, h("h3", null, "Favourites"), favList),
      h(
        "section",
        { class: "editor-group" },
        h("h3", null, "Paste code"),
        h("div", { class: "editor-row" }, pasteInput, h("button", { type: "button", onclick: () => void openCode(pasteInput.value, "pasted code") }, "Open")),
      ),
      h("section", { class: "editor-group" }, h("h3", null, "Map code"), codeBox),
    ),
  );
  menu.hidden = true;
  menu.addEventListener("keydown", (e) => {
    if (e.key !== "Escape") return;
    e.stopPropagation();
    toggleMenu(false);
    menuBtn.focus();
  });

  const layout = h("div", { class: "editor-body" }, toolRail, stage, sideEl);
  const toolsPart = [topbar, layout, menu];

  fileInput.addEventListener("change", () => {
    const file = fileInput.files?.[0];
    fileInput.value = "";
    if (!file) return;
    void readMapFile(file)
      .then((doc) => {
        if (replaceMap(doc, file.name)) libraryMap = null;
      })
      .catch((err: unknown) => ctx.toast(errorText(err), "error"));
  });

  const editorNodes: Node[] = toolsPart;
  root.replaceChildren(...editorNodes);

  /** Opens or closes the inspector sheet on phones (no effect on desktop). */
  function setSide(open: boolean): void {
    sideEl.dataset.open = String(open);
    sideToggle.setAttribute("aria-expanded", String(open));
  }

  // Shows the current selection's inspector. Focus inside the inspector with an
  // unchanged selection keeps the inspector as it is, so typing is not interrupted.
  function refreshInspector(): void {
    const doc = ctrl.doc;
    const scope = ctrl.scope;
    const sel = `${ctrl.sel.map((r) => JSON.stringify(r)).join("|")}/${JSON.stringify(scope)}`;
    if (doc === shownDoc && sel === shownSel) return;
    const sameSel = sel === shownSel;
    shownDoc = doc;
    if (sameSel && inspectorHost.contains(document.activeElement)) return;
    shownSel = sel;
    inspectorHost.replaceChildren(
      renderInspector({
        doc,
        sel: ctrl.sel,
        scope,
        commit: (next) => ctrl.commit(next),
        remove: () => ctrl.removeSelection(),
      }),
    );
  }

  function refresh(): void {
    for (const [tool, btn] of toolButtons) btn.setAttribute("aria-pressed", String(tool === ctrl.tool));
    undoBtn.disabled = !ctrl.canUndo;
    redoBtn.disabled = !ctrl.canRedo;
    const scope = ctrl.scope;
    scopeBar.hidden = !scope;
    scopeText.textContent = scope ? `Editing shapes inside body ${scope.id}. Esc returns.` : "";
    mergeBtn.disabled = ctrl.sel.filter((r) => r.kind === "body").length < 2;
    const shapes = ctrl.physicsShapes;
    lagEl.textContent = `${shapes} physics shapes: ${lagVerdict(shapes)}`;
    hintEl.textContent = ctrl.message || ctrl.hint;
    if (document.activeElement !== nameInput) nameInput.value = mapName ?? "";
    sideTitle.textContent = sideToggleLabel.textContent = ctrl.sel.length > 0 || scope ? "Selection" : "Map settings";
    refreshInspector();
  }

  /** Back leaves to the room when the editor was opened from it; otherwise to the screen it came from. */
  function exit(): void {
    if (inRoom) ctx.store.set({ screen: "room", editorForRoom: false });
    else ctx.store.set({ screen: origin });
  }

  function toggleMenu(show?: boolean): void {
    const on = show ?? menu.hidden;
    menu.hidden = !on;
    menuBtn.setAttribute("aria-expanded", String(on));
    if (on) {
      refreshMenu();
      menuClose.focus();
    }
  }

  function isEmptyMap(): boolean {
    return JSON.stringify(ctrl.doc) === JSON.stringify(emptyDoc());
  }

  /** Replace the open map; asks first when the current map is not empty. Returns false when the user declined. */
  function replaceMap(doc: Obj, label: string): boolean {
    if (!isEmptyMap() && !window.confirm("Replace the current map?")) return false;
    ctrl.load(doc);
    mapName = label;
    toggleMenu(false);
    ctx.toast(`Opened ${label}`);
    return true;
  }

  function newMap(): void {
    if (!isEmptyMap() && !window.confirm("Start a new map? The current map is replaced.")) return;
    ctrl.load(emptyDoc());
    mapName = null;
    libraryMap = null;
    toggleMenu(false);
  }

  async function decode(code: string): Promise<Obj> {
    const eng = await ctx.engine();
    return parseMap(eng.mapDecode(code.trim()));
  }

  /** Open a map code. `from` is the library entry it came from, when Save should update that entry. */
  async function openCode(code: string, label: string, from: LibraryMap | null = null): Promise<void> {
    try {
      const doc = await decode(code);
      if (replaceMap(doc, label)) libraryMap = from;
    } catch (err) {
      ctx.toast(errorText(err), "error");
    }
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
      ctx.toast(errorText(err), "error");
    }
  }

  async function showBuiltins(): Promise<void> {
    builtinList.replaceChildren(h("p", { class: "editor-status" }, "Loading maps…"));
    try {
      const maps = await ctx.maps();
      builtinList.replaceChildren(
        ...maps.map((m) => h("button", { type: "button", class: "editor-item", onclick: () => void openCode(m.code, m.name) }, m.name)),
      );
    } catch (err) {
      builtinList.replaceChildren(h("p", { class: "editor-status error" }, errorText(err)));
    }
  }

  /** `owned` maps (the player's own) can be overwritten by Save; favourites open as copies. */
  function openLibraryMap(m: LibraryMap, owned: boolean): void {
    mapCode(m.id)
      .then((code) => openCode(code, m.name, owned ? m : null))
      .catch((err: unknown) => ctx.toast(errorText(err), "error"));
  }

  /** Buttons for a list of library maps, or a notice when the list is empty or failed. */
  function libraryButtons(result: PromiseSettledResult<LibraryMap[]>, empty: string, owned: boolean): Node[] {
    if (result.status === "rejected") return [h("p", { class: "editor-status error" }, errorText(result.reason))];
    if (result.value.length === 0) return [h("p", { class: "editor-status" }, empty)];
    return result.value.map((m) =>
      h("button", { type: "button", class: "editor-item", onclick: () => openLibraryMap(m, owned) }, `${m.name} · ${VISIBILITY_LABELS[m.visibility]}`),
    );
  }

  async function showMine(): Promise<void> {
    if (!ctx.store.state.account) {
      mineList.replaceChildren(signInPrompt(ctx, "Sign in to open your saved maps."));
      favList.replaceChildren(h("p", { class: "editor-status" }, "Sign in to see your favourites."));
      return;
    }
    mineList.replaceChildren(h("p", { class: "editor-status" }, "Loading your maps…"));
    favList.replaceChildren(h("p", { class: "editor-status" }, "Loading favourites…"));
    const [mine, favs] = await Promise.allSettled([listMine(), listFavourites()]);
    mineList.replaceChildren(...libraryButtons(mine, "No saved maps yet.", true));
    favList.replaceChildren(...libraryButtons(favs, "No favourites yet.", false));
  }

  /** The save dialog: a name, a description and visibility. Overwrites the open library map or uploads a new one. */
  function openSaveDialog(): void {
    if (!ctx.store.state.account) {
      openModal({ title: "Save to library", body: [signInPrompt(ctx, "Sign in to save maps to your library.")] });
      return;
    }
    const current = libraryMap;
    const name = h("input", { type: "text", placeholder: "Map name", maxlength: 40 });
    name.value = current?.name ?? mapName ?? "";
    const description = h("textarea", { rows: 3, placeholder: "What is the map about?" });
    description.value = current?.description ?? "";
    let visibility: Visibility = current?.visibility ?? "public";
    const visibilityRow = seg(
      "Visibility",
      VISIBILITIES.map((v) => ({ value: v, label: VISIBILITY_LABELS[v] })),
      visibility,
      (v) => {
        visibility = v;
      },
    );
    const fields = (): SaveFields => ({ name: name.value, description: description.value, visibility });
    let modal: { close(): void } | null = null;
    const done = (): void => modal?.close();
    const cancel = h("button", { type: "button", class: "quiet" }, "Cancel");
    cancel.addEventListener("click", done);
    const primary = h("button", { type: "button", class: "primary" }, current ? "Overwrite" : "Upload");
    primary.addEventListener("click", () => void saveToLibrary(current ? "overwrite" : "new", fields(), primary, done));
    const actions = [cancel, primary];
    if (current) {
      const asNew = h("button", { type: "button" }, "Save as new");
      asNew.addEventListener("click", () => void saveToLibrary("new", fields(), asNew, done));
      actions.push(asNew);
    }
    modal = openModal({
      title: "Save to library",
      body: [
        field("Map name", name),
        field("Description", description),
        h("div", { class: "field" }, h("span", { class: "field-label" }, "Visibility"), visibilityRow.el),
        h("p", { class: "field-hint" }, "Public maps appear in the library after approval."),
      ],
      actions,
    });
  }

  /** `overwrite` updates the open library map (after a confirm); `new` uploads a copy. `done` closes the dialog on success. */
  async function saveToLibrary(mode: "new" | "overwrite", f: SaveFields, btn: HTMLButtonElement, done: () => void): Promise<void> {
    const title = f.name.trim();
    if (!title) {
      ctx.toast("Give the map a name", "error");
      return;
    }
    const target = mode === "overwrite" ? libraryMap : null;
    if (target && !window.confirm(`Overwrite “${target.name}”?`)) return;
    const description = f.description.trim();
    let code: string;
    try {
      code = ctx.wasm.mapEncode(mapText(ctrl.doc));
    } catch (err) {
      ctx.toast(errorText(err), "error");
      return;
    }
    btn.disabled = true;
    try {
      if (target) {
        await updateMap(target.id, { name: title, description, visibility: f.visibility, code });
        libraryMap = { ...target, name: title, description, visibility: f.visibility };
      } else {
        await uploadMap({ name: title, description, code, visibility: f.visibility });
        libraryMap = await findUploaded(title);
      }
      mapName = title;
      done();
      ctx.toast("Saved to your library");
      void showMine();
    } catch (err) {
      ctx.toast(errorText(err), "error");
    } finally {
      btn.disabled = false;
    }
  }

  /** The newest of the player's maps with this name: the one an upload just created. */
  async function findUploaded(title: string): Promise<LibraryMap | null> {
    const mine = await listMine();
    return mine.filter((m) => m.name === title).sort((a, b) => b.id - a.id)[0] ?? null;
  }

  function refreshMenu(): void {
    refreshCode();
    void showBuiltins();
    void showMine();
  }

  /** Room mode: tell the room the editor is open, then load the room's map (blank when that fails). */
  async function loadRoomMap(): Promise<void> {
    ctx.send({ t: "editing", open: true });
    try {
      const room = await ctx.roomMap();
      if (destroyed) return;
      if (room.code) ctrl.load(await decode(room.code));
      mapName = room.name || null;
    } catch (err) {
      ctx.toast(`Could not load the room map: ${errorText(err)}`, "error");
    }
  }

  /** Room mode: send the map back to the room and leave the editor. */
  function useInRoom(): void {
    let code: string;
    try {
      code = ctx.wasm.mapEncode(mapText(ctrl.doc));
    } catch (err) {
      ctx.toast(errorText(err), "error");
      return;
    }
    ctx.send({ t: "set_map", code, name: mapName });
    ctx.store.set({ screen: "room", editorForRoom: false });
  }

  /** Test play replaces the editor layout with the game's touch layer. */
  async function playTest(): Promise<void> {
    if (testing || starting || destroyed) return;
    starting = true;
    let started: TestPlay;
    try {
      started = await startTestPlay(ctx, ctrl.doc, (failure) => stopTest(failure));
    } catch (err) {
      ctx.toast(`Could not start test play: ${errorText(err)}`, "error");
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

  setSide(false);
  refresh();
  if (inRoom) void loadRoomMap();

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
      if (inRoom) ctx.send({ t: "editing", open: false });
      ctrl.destroy();
    },
  };
};

interface SaveFields {
  name: string;
  description: string;
  visibility: Visibility;
}
