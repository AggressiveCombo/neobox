// Map editor: draw a map on a canvas, tune its objects in the inspector, test-play
// it, and open or save it (file, built-in map, library or pasted code). Pointers
// and keys are handled by editor/controller.ts; this screen lays out the controls.
// Opened from a room (store.editorForRoom), it edits the room's map and can send
// the result back to the room.

import { deleteMap, errorText, listFavourites, listMine, updateMap, uploadMap, type LibraryMap, type Visibility } from "../../account";
import type { ScreenFactory } from "../../ctx";
import { EditorController, lagVerdict, type Tool } from "../../editor/controller";
import { downloadMap, mapText, parseMap, readMapFile } from "../../editor/io";
import { renderInspector } from "../../editor/inspector";
import { emptyDoc, hexColor, type Obj } from "../../editor/schema";
import { TEST_PLAY_DEFAULT_MODE, startTestPlay, type TestPlay } from "../../editor/testplay";
import { engineLoader } from "../../engine-loader";
import { GAME_MODES } from "../../protocol";
import type { Screen } from "../../state";
import { h } from "../dom";
import { engineStatus, type EngineStatus } from "../engine-status";
import { icon, type IconName } from "../icons";
import { confirmDialog, field, openModal, seg, setFieldError, uid } from "../kit";
import { openLibraryPicker } from "../library-picker";
import { VISIBILITY_LABELS, mapCode } from "../map-list";
import { signInPrompt } from "./account";

/** A map queued by another screen (e.g. Library -> Open in editor) to load once the editor mounts. */
let queuedEditorMap: { name: string; code: string } | null = null;

/** Open this map in the editor the next time the editor screen mounts. */
export function queueEditorMap(name: string, code: string): void {
  queuedEditorMap = { name, code };
}

/** Tool groups in rail order; a divider sits between them. */
const TOOL_GROUPS: { tool: Tool; label: string; key: string; icon: IconName }[][] = [
  [{ tool: "select", label: "Select", key: "Q", icon: "mouse-pointer-2" }],
  [
    { tool: "rect", label: "Box", key: "W", icon: "square" },
    { tool: "circle", label: "Circle", key: "E", icon: "circle" },
    { tool: "poly", label: "Polygon", key: "R", icon: "pentagon" },
    { tool: "fill", label: "Fill", key: "U", icon: "paint-bucket" },
  ],
  [{ tool: "joint", label: "Joint", key: "J", icon: "link-2" }],
  [
    { tool: "spawn", label: "Spawn", key: "T", icon: "flag" },
    { tool: "turret", label: "Turret", key: "I", icon: "crosshair" },
    { tool: "grapple", label: "Grapple", key: "G", icon: "anchor" },
    { tool: "cap", label: "Capture", key: "Y", icon: "target" },
  ],
];
const VISIBILITIES: Visibility[] = ["public", "unlisted", "private"];

/** A square icon-only button; `label` is its accessible name and tooltip. */
function iconButton(name: IconName, label: string, onclick: () => void): HTMLButtonElement {
  return h("button", { type: "button", class: "icon", "aria-label": label, title: label, onclick }, icon(name));
}

/** Writes only a changed value: an unchanged write still dirties style and layout, and the chrome refreshes on every selection change. */
function setText(el: Element, text: string): void {
  if (el.textContent !== text) el.textContent = text;
}
function setAttr(el: Element, name: string, value: string): void {
  if (el.getAttribute(name) !== value) el.setAttribute(name, value);
}
function setDisabled(el: HTMLButtonElement, off: boolean): void {
  if (el.disabled !== off) el.disabled = off;
}

export const editorScreen: ScreenFactory = (ctx) => {
  const root = h("main", { class: "screen editor" });
  // Room mode: the editor was opened from a room and edits that room's map.
  const inRoom = ctx.store.state.editorForRoom;
  let origin: Screen = "menu";
  let originKnown = false;
  let destroyed = false;
  let starting = false;
  /** The engine's loading or failure strip, shown while a test play waits for it. */
  let engineUi: EngineStatus | null = null;
  let testing: TestPlay | null = null;
  let shownDoc: Obj | null = null;
  let shownSel = "";
  /** Name of the map on screen, sent to the room by "Use in room". */
  let mapName: string | null = null;
  /** The player's own library map on screen (Save overwrites it), or null. */
  let libraryMap: LibraryMap | null = null;
  let closePicker: (() => void) | null = null;
  /** The map and its name as last loaded, saved or downloaded; edits since then are unsaved. */
  let savedState = "";

  // Viewport: the canvas, the scope bar and the lag verdict over it.
  const canvas = h("canvas", { class: "editor-canvas", "aria-label": "Map canvas" });
  const lagEl = h("p", { class: "editor-lag", role: "status" });
  const scopeText = h("span", {});
  const scopeBar = h("div", { class: "editor-scope", role: "status" }, scopeText, h("button", { type: "button", onclick: () => ctrl.leaveScope() }, icon("arrow-left", 18), "Leave body"));
  scopeBar.hidden = true;
  const emptyEl = h(
    "p",
    { class: "empty editor-empty" },
    icon("map", 40),
    "Your map is empty. Start with a platform: choose Box, then drag it on the canvas.",
    h("button", { type: "button", class: "primary", onclick: () => ctrl.setTool("rect") }, icon("square", 18), "Draw a platform"),
  );
  const viewport = h("div", { class: "editor-viewport" }, canvas, scopeBar, lagEl, emptyEl);
  const ctrl = new EditorController(canvas, () => refresh(), !inRoom);
  const observer = new ResizeObserver(() => {
    if (viewport.isConnected) ctrl.resize();
  });
  observer.observe(viewport);

  const inspectorId = uid("editor-inspector");
  const sideToggleLabel = h("span", { class: "editor-label" }, "Map settings");
  const sideToggle = h(
    "button",
    { type: "button", class: "editor-side-toggle", "aria-expanded": "false", "aria-controls": inspectorId, onclick: () => setSide(!sideShown()) },
    icon("sliders-horizontal"),
    sideToggleLabel,
  );
  // The inspector toggle heads the tool rail on phones and narrow windows, and on desktop while the inspector is collapsed.
  const settingsGroup = h("div", { class: "editor-tool-group editor-settings-group" }, sideToggle);

  const toolButtons = new Map<Tool, HTMLButtonElement>();
  const toolRail = h(
    "div",
    { class: "editor-tools", role: "toolbar", "aria-label": "Tools" },
    settingsGroup,
    TOOL_GROUPS.map((group) =>
      h(
        "div",
        { class: "editor-tool-group" },
        group.map(({ tool, label, key, icon: name }) => {
          const btn = h(
            "button",
            { type: "button", class: "editor-tool", "aria-label": label, "aria-keyshortcuts": key, title: `${label} (${key})`, onclick: () => ctrl.setTool(tool) },
            icon(name),
          );
          toolButtons.set(tool, btn);
          return btn;
        }),
      ),
    ),
  );

  const undoBtn = iconButton("undo-2", "Undo", () => ctrl.undo());
  const redoBtn = iconButton("redo-2", "Redo", () => ctrl.redo());
  const saveBtn = iconButton("save", "Save", () => openSaveDialog());
  const copyBtn = iconButton("copy", "Copy (Ctrl+C)", () => ctrl.copySelection());
  const cutBtn = iconButton("scissors", "Cut (Ctrl+X)", () => ctrl.cutSelection());
  const pasteBtn = iconButton("clipboard", "Paste (Ctrl+V)", () => ctrl.pasteSelection());
  const mergeBtn = iconButton("combine", "Merge shapes", () => ctrl.mergeSelected());
  const deleteBtn = iconButton("trash-2", "Delete", () => ctrl.removeSelection());
  const zoomOutBtn = iconButton("zoom-out", "Zoom out", () => ctrl.zoomBy(0.8));
  const zoomInBtn = iconButton("zoom-in", "Zoom in", () => ctrl.zoomBy(1.25));
  const resetZoomBtn = iconButton("rotate-ccw", "Reset zoom", () => ctrl.resetZoom());
  const colourInput = h("input", {
    type: "color",
    class: "editor-colour",
    title: "Fill colour",
    "aria-label": "Fill colour",
    value: `#${ctrl.fillColour.toString(16).padStart(6, "0")}`,
  });
  colourInput.addEventListener("input", () => ctrl.setFillColour(hexColor(colourInput.value)));
  const useRoomBtn = h(
    "button",
    { type: "button", class: "primary", "aria-label": "Use in room", onclick: () => useInRoom() },
    icon("door-open"),
    h("span", { class: "editor-label" }, "Use in room"),
  );
  useRoomBtn.hidden = !inRoom;
  // Test play is the screen's one primary action; in room mode "Use in room" takes that role.
  const testBtn = h(
    "button",
    { type: "button", class: inRoom ? "" : "primary", "aria-label": "Test play", onclick: () => void playTest() },
    icon("play"),
    h("span", { class: "editor-label" }, "Test play"),
  );
  // The game mode test play starts in; a map built for one mode (a deathball, a capture map) is tried in that mode.
  const modeSelect = h(
    "select",
    { class: "editor-mode", "aria-label": "Test play mode", title: "Test play mode" },
    ...GAME_MODES.map((m) => h("option", { value: String(m.id), selected: m.id === TEST_PLAY_DEFAULT_MODE }, m.name)),
  );
  // Edit and view controls float over the canvas, bottom right.
  viewport.append(
    h(
      "div",
      { class: "editor-float" },
      h("div", { class: "editor-cluster", role: "group", "aria-label": "Edit" }, colourInput, copyBtn, cutBtn, pasteBtn, mergeBtn, deleteBtn),
      h("div", { class: "editor-cluster", role: "group", "aria-label": "View" }, zoomOutBtn, zoomInBtn, resetZoomBtn),
    ),
  );

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
    h("button", { type: "button", class: "quiet", "aria-label": "Back", onclick: () => void exit() }, icon("arrow-left"), h("span", { class: "editor-label" }, "Back")),
    h("h1", { class: "editor-sr" }, "Map editor"),
    nameInput,
    h("div", { class: "editor-top-tools" }, undoBtn, redoBtn, saveBtn, useRoomBtn, modeSelect, testBtn, menuBtn),
  );

  // Footer under the canvas: the hint. Phones hide it visually; it is still announced.
  const hintEl = h("p", { class: "editor-hint", role: "status", "aria-live": "polite" });
  const foot = h("div", { class: "editor-foot" }, hintEl);
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
      h("button", { type: "button", class: "icon", "aria-label": "Close inspector", onclick: () => setSide(false) }, icon("x")),
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
  const menuClose = h("button", { type: "button", class: "quiet", onclick: () => toggleMenu(false) }, icon("x", 18), "Close");
  const deleteMapBtn = h(
    "button",
    {
      type: "button",
      class: "danger",
      hidden: true,
      onclick: () => {
        if (libraryMap) void deleteLibraryMap(libraryMap);
      },
    },
    icon("trash-2"),
    "Delete map",
  );
  const menu = h(
    "div",
    { class: "editor-menu", id: menuId, role: "dialog", "aria-label": "Map menu" },
    h("div", { class: "editor-menu-head" }, h("h2", null, icon("map", 20), "Map"), menuClose),
    h(
      "div",
      { class: "editor-menu-body" },
      h(
        "section",
        { class: "editor-group" },
        h("h3", null, icon("folder-open", 20), "File"),
        h(
          "div",
          { class: "editor-buttons" },
          h("button", { type: "button", onclick: () => { toggleMenu(false); openSaveDialog(); } }, icon("save"), "Save to library"),
          h("button", { type: "button", onclick: () => openHitboxImport() }, icon("globe"), "Import from Hitbox.io"),
          h("button", { type: "button", onclick: () => fileInput.click() }, icon("folder-open"), "Load file"),
          h("button", { type: "button", onclick: () => { downloadMap(ctrl.doc); markSaved(); } }, icon("download"), "Download"),
          h("button", { type: "button", onclick: () => void copyCode() }, icon("copy"), "Copy map code"),
          h("button", { type: "button", onclick: () => void newMap() }, icon("file-plus"), "New map"),
          deleteMapBtn,
        ),
        fileInput,
      ),
      h("section", { class: "editor-group" }, h("h3", null, icon("library-big", 20), "Built-in maps"), builtinList),
      h("section", { class: "editor-group" }, h("h3", null, icon("map", 20), "My maps"), mineList),
      h("section", { class: "editor-group" }, h("h3", null, icon("star", 20), "Favourites"), favList),
      h(
        "section",
        { class: "editor-group" },
        h("h3", null, icon("clipboard", 20), "Paste code"),
        h("div", { class: "editor-row" }, pasteInput, h("button", { type: "button", onclick: () => void openCode(pasteInput.value, "pasted code") }, icon("folder-open", 18), "Open")),
      ),
      h("section", { class: "editor-group" }, h("h3", null, icon("clipboard", 20), "Map code"), codeBox),
    ),
  );
  menu.dataset.open = "false";
  menu.addEventListener("keydown", (e) => {
    if (e.key !== "Escape") return;
    e.stopPropagation();
    toggleMenu(false);
    menuBtn.focus();
  });

  const layout = h("div", { class: "editor-body" }, toolRail, stage, sideEl);
  // Tab order follows the screen: on portrait phones the rail sits under the stage, so the DOM moves with it.
  const portraitPhone = matchMedia("(max-width: 600px) and (orientation: portrait)");
  const placeRail = (): void => {
    layout.insertBefore(toolRail, portraitPhone.matches ? sideEl : stage);
  };
  placeRail();
  portraitPhone.addEventListener("change", placeRail);
  const toolsPart = [topbar, layout, menu];

  fileInput.addEventListener("change", () => {
    const file = fileInput.files?.[0];
    fileInput.value = "";
    if (!file) return;
    void readMapFile(file)
      .then(async (doc) => {
        if (await replaceMap(doc, file.name)) libraryMap = null;
      })
      .catch((err: unknown) => ctx.toast(errorText(err), "error"));
  });

  const editorNodes: Node[] = toolsPart;
  root.replaceChildren(...editorNodes);

  // Desktop docks the inspector beside the canvas (collapsible); narrow windows slide it over the canvas as a sheet.
  const desktopSide = matchMedia("(min-width: 900px)");
  const sideShown = (): boolean => (desktopSide.matches ? sideEl.dataset.collapsed !== "true" : sideEl.dataset.open === "true");

  /** Shows or hides the inspector: the sheet on phones and narrow windows, the docked panel on desktop. */
  function setSide(open: boolean): void {
    if (desktopSide.matches) sideEl.dataset.collapsed = String(!open);
    else sideEl.dataset.open = String(open);
    sideToggle.setAttribute("aria-expanded", String(open));
  }

  // Shows the current selection's inspector. Focus inside the inspector with an
  // unchanged selection keeps the inspector as it is, so typing is not interrupted.
  // The rebuild runs in a later task: rebuilding inside the press would dirty the
  // DOM ahead of the press's hit test, which forces a full style and layout.
  let inspectorTimer = 0;
  function refreshInspector(): void {
    // During a gesture the selection and document change every step; the rebuild waits for the release, which notifies.
    if (ctrl.dragging) return;
    const doc = ctrl.doc;
    const scope = ctrl.scope;
    const sel = `${ctrl.sel.map((r) => JSON.stringify(r)).join("|")}/${JSON.stringify(scope)}`;
    if (doc === shownDoc && sel === shownSel) return;
    const sameSel = sel === shownSel;
    shownDoc = doc;
    if (sameSel && inspectorHost.contains(document.activeElement)) return;
    shownSel = sel;
    clearTimeout(inspectorTimer);
    inspectorTimer = window.setTimeout(() => {
      // A focused field may hold an edit that commits on blur: blur first, so the edit lands before the rebuild replaces its input.
      const focused = document.activeElement;
      if (focused instanceof HTMLElement && inspectorHost.contains(focused)) focused.blur();
      inspectorHost.replaceChildren(
        renderInspector({
          doc: ctrl.doc,
          sel: ctrl.sel,
          scope: ctrl.scope,
          commit: (edit) => ctrl.commit(edit(ctrl.doc)),
          remove: () => ctrl.removeSelection(),
        }),
      );
    }, 0);
  }

  function refresh(): void {
    for (const [tool, btn] of toolButtons) setAttr(btn, "aria-pressed", String(tool === ctrl.tool));
    setDisabled(undoBtn, !ctrl.canUndo);
    setDisabled(redoBtn, !ctrl.canRedo);
    setDisabled(resetZoomBtn, ctrl.atFit);
    const scope = ctrl.scope;
    const showEmpty = !scope && isEmptyMap();
    if (emptyEl.hidden === showEmpty) emptyEl.hidden = !showEmpty;
    if (scopeBar.hidden !== !scope) scopeBar.hidden = !scope;
    setText(scopeText, scope ? `Editing shapes inside body ${scope.id}. Esc returns.` : "");
    setDisabled(copyBtn, !ctrl.hasSelection);
    setDisabled(cutBtn, !ctrl.hasSelection);
    setDisabled(pasteBtn, !ctrl.hasClipboard);
    setDisabled(mergeBtn, ctrl.sel.filter((r) => r.kind === "body").length < 2);
    setDisabled(deleteBtn, !ctrl.hasSelection);
    const shapes = ctrl.physicsShapes;
    setText(lagEl, `${shapes} physics ${shapes === 1 ? "shape" : "shapes"}: ${lagVerdict(shapes)}`);
    setText(hintEl, ctrl.message || ctrl.hint);
    if (document.activeElement !== nameInput && nameInput.value !== (mapName ?? "")) nameInput.value = mapName ?? "";
    const sideName = ctrl.sel.length > 0 || scope ? "Selection" : "Map settings";
    setText(sideTitle, sideName);
    setText(sideToggleLabel, sideName);
    setAttr(sideToggle, "title", sideName);
    setAttr(sideToggle, "aria-label", sideName);
    refreshInspector();
  }

  /** Record the map on screen as saved: Leave and page unload compare against it. */
  function markSaved(): void {
    savedState = JSON.stringify([ctrl.doc, mapName]);
  }

  /** Warns before the page closes or reloads while edits are unsaved. */
  function onBeforeUnload(e: BeforeUnloadEvent): void {
    if (JSON.stringify([ctrl.doc, mapName]) === savedState) return;
    e.preventDefault();
    e.returnValue = "";
  }

  /** Back leaves to the room when the editor was opened from it; otherwise to the screen it came from. Asks first when edits are unsaved. */
  async function exit(): Promise<void> {
    if (JSON.stringify([ctrl.doc, mapName]) !== savedState) {
      const ok = await confirmDialog({
        title: "Leave without saving?",
        message: "Edits not saved to the library or a file are lost.",
        action: "Leave",
      });
      if (!ok || destroyed) return;
    }
    if (inRoom) ctx.store.set({ screen: "room", editorForRoom: false });
    else ctx.store.set({ screen: origin });
  }

  function toggleMenu(show?: boolean): void {
    const on = show ?? menu.dataset.open !== "true";
    menu.dataset.open = String(on);
    menuBtn.setAttribute("aria-expanded", String(on));
    if (on) {
      refreshMenu();
      menuClose.focus();
    }
  }

  function isEmptyMap(): boolean {
    return JSON.stringify(ctrl.doc) === JSON.stringify(emptyDoc());
  }

  /** Replace the open map; asks first when the current map is not empty. Resolves false when the user declined. */
  async function replaceMap(doc: Obj, label: string): Promise<boolean> {
    if (!isEmptyMap()) {
      const ok = await confirmDialog({
        title: "Replace the current map?",
        message: "Edits not saved to the library or a file are lost.",
        action: "Replace map",
      });
      if (!ok) return false;
    }
    ctrl.load(doc);
    mapName = label;
    refresh();
    markSaved();
    toggleMenu(false);
    ctx.toast(`Opened ${label}`);
    return true;
  }

  async function newMap(): Promise<void> {
    if (!isEmptyMap()) {
      const ok = await confirmDialog({
        title: "Start a new map?",
        message: "The current map is replaced with an empty one. Edits not saved are lost.",
        action: "Start new map",
      });
      if (!ok) return;
    }
    ctrl.load(emptyDoc());
    mapName = null;
    refresh();
    libraryMap = null;
    markSaved();
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
      if (await replaceMap(doc, label)) libraryMap = from;
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
        ...maps.map((m) => h("button", { type: "button", class: "editor-item list-row", onclick: () => void openCode(m.code, m.name) }, icon("map", 18), m.name)),
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

  /** Open the Hitbox.io map picker; clicking any map imports it straight into the editor. */
  function openHitboxImport(): void {
    toggleMenu(false);
    closePicker?.();
    closePicker = openLibraryPicker(
      ctx,
      (picked) => {
        closePicker = null;
        void openCode(picked.code, picked.name, null);
      },
      "hitbox",
    );
  }

  async function deleteLibraryMap(m: LibraryMap): Promise<boolean> {
    const ok = await confirmDialog({
      title: `Delete "${m.name}"?`,
      message: "This removes the map from your library and cannot be undone.",
      action: "Delete map",
    });
    if (!ok) return false;
    try {
      await deleteMap(m.id);
      if (libraryMap?.id === m.id) {
        libraryMap = null;
        deleteMapBtn.hidden = true;
      }
      ctx.toast("Map deleted.");
      void showMine();
      return true;
    } catch (err) {
      ctx.toast(errorText(err), "error");
      return false;
    }
  }

  /** Buttons for a list of library maps, or a notice when the list is empty or failed. */
  function libraryButtons(result: PromiseSettledResult<LibraryMap[]>, empty: string, owned: boolean): Node[] {
    if (result.status === "rejected") return [h("p", { class: "editor-status error" }, errorText(result.reason))];
    if (result.value.length === 0) return [h("p", { class: "editor-status" }, empty)];
    return result.value.map((m) => {
      const openBtn = h(
        "button",
        { type: "button", class: "editor-item list-row", onclick: () => openLibraryMap(m, owned) },
        icon("map", 18),
        `${m.name} · ${VISIBILITY_LABELS[m.visibility]}`,
      );
      if (!owned) return openBtn;
      return h(
        "div",
        { class: "editor-map-row" },
        openBtn,
        h(
          "button",
          {
            type: "button",
            class: "danger editor-map-del",
            "aria-label": `Delete ${m.name}`,
            title: "Delete map",
            onclick: () => void deleteLibraryMap(m),
          },
          icon("trash-2", 16),
        ),
      );
    });
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
      const actions: HTMLButtonElement[] = [];
      if (!isEmptyMap()) {
        const download = h("button", { type: "button" }, icon("download"), "Download map file");
        download.addEventListener("click", () => {
          downloadMap(ctrl.doc);
          markSaved();
          modal.close();
        });
        actions.push(download);
      }
      const modal = openModal({
        title: "Save to library",
        body: [signInPrompt(ctx, "Saving to the library needs an account. Sign in to save this map.")],
        actions,
      });
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
    /** Checks the name in its field, then saves. */
    const save = (mode: "new" | "overwrite", btn: HTMLButtonElement): void => {
      setFieldError(name, null);
      if (name.value.trim() === "") {
        setFieldError(name, "Give the map a name.");
        name.focus();
        return;
      }
      void saveToLibrary(mode, fields(), btn, done);
    };
    const primary = h("button", { type: "button", class: "primary" }, icon(current ? "save" : "upload", 18), current ? "Overwrite" : "Upload");
    primary.addEventListener("click", () => save(current ? "overwrite" : "new", primary));
    const actions = [cancel, primary];
    if (current) {
      const asNew = h("button", { type: "button" }, icon("save", 18), "Save as new");
      asNew.addEventListener("click", () => save("new", asNew));
      const del = h("button", { type: "button", class: "danger" }, icon("trash-2", 18), "Delete map");
      del.addEventListener("click", () => {
        void deleteLibraryMap(current).then((removed) => {
          if (removed) done();
        });
      });
      actions.push(asNew, del);
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

  /** `overwrite` updates the open library map (after a confirm); `new` uploads a copy. `done` closes the dialog on success. The caller checks the name. */
  async function saveToLibrary(mode: "new" | "overwrite", f: SaveFields, btn: HTMLButtonElement, done: () => void): Promise<void> {
    const title = f.name.trim();
    const target = mode === "overwrite" ? libraryMap : null;
    if (target) {
      const ok = await confirmDialog({
        title: `Overwrite “${target.name}”?`,
        message: "The library copy is replaced with the map on screen.",
        action: "Overwrite",
      });
      if (!ok) return;
    }
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
      markSaved();
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
    deleteMapBtn.hidden = libraryMap === null;
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
    markSaved();
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
    testBtn.disabled = true;
    testBtn.setAttribute("aria-busy", "true");
    // The engine loads on first use: the strip shows its progress, or the failure with Try again, which resumes the play.
    if (!engineLoader.ready) {
      engineUi = engineStatus(() => void startPlay());
      root.insertBefore(engineUi.el, layout);
    }
    await startPlay();
  }

  /** Starts the game once the engine is up; a failed engine keeps the request pending for Try again. */
  async function startPlay(): Promise<void> {
    let started: TestPlay;
    try {
      started = await startTestPlay(ctx, ctrl.doc, Number(modeSelect.value), (failure) => stopTest(failure));
    } catch (err) {
      if (destroyed || engineLoader.state.status === "failed") return;
      endPlayWait();
      ctx.toast(`Could not start test play: ${errorText(err)}`, "error");
      return;
    }
    endPlayWait();
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

  /** Test play is no longer waiting: the button is usable again and the engine strip goes. */
  function endPlayWait(): void {
    starting = false;
    testBtn.disabled = false;
    testBtn.removeAttribute("aria-busy");
    engineUi?.destroy();
    engineUi?.el.remove();
    engineUi = null;
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

  // Docked and shown on desktop; the sheet starts closed on phones and narrow windows.
  setSide(desktopSide.matches);
  refresh();
  markSaved();
  window.addEventListener("beforeunload", onBeforeUnload);
  if (inRoom) {
    queuedEditorMap = null;
    void loadRoomMap();
  } else if (queuedEditorMap !== null) {
    const queued = queuedEditorMap;
    queuedEditorMap = null;
    void openCode(queued.code, queued.name, null);
  }

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
      closePicker?.();
      closePicker = null;
      endPlayWait();
      window.removeEventListener("beforeunload", onBeforeUnload);
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
