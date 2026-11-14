// Map editor: draw a map on a canvas, tune its objects in the inspector, test-play
// it, and open or save it (file, built-in map, library or pasted code). Pointers
// and keys are handled by editor/controller.ts; this screen lays out the controls.
// Opened from a room (store.editorForRoom), it edits the room's map and can send
// the result back to the room.

import { errorText, listFavourites, listMine, updateMap, uploadMap, type LibraryMap, type Visibility } from "../../account";
import type { AppCtx, ScreenFactory } from "../../ctx";
import { EditorController, lagVerdict, type Tool } from "../../editor/controller";
import { downloadMap, mapText, parseMap, readMapFile } from "../../editor/io";
import { renderInspector } from "../../editor/inspector";
import { emptyDoc, hexColor, type Obj } from "../../editor/schema";
import { startTestPlay, type TestPlay } from "../../editor/testplay";
import type { Screen } from "../../state";
import { h } from "../dom";
import { VISIBILITY_LABELS, mapCode } from "../map-list";
import { signInPrompt } from "./account";

const TOOLS: { tool: Tool; label: string; key: string }[] = [
  { tool: "select", label: "Select", key: "Q" },
  { tool: "rect", label: "Box", key: "W" },
  { tool: "circle", label: "Circle", key: "E" },
  { tool: "poly", label: "Polygon", key: "R" },
  { tool: "joint", label: "Joint", key: "J" },
  { tool: "spawn", label: "Spawn", key: "T" },
  { tool: "turret", label: "Turret", key: "I" },
  { tool: "grapple", label: "Grapple", key: "G" },
  { tool: "cap", label: "Capture", key: "Y" },
  { tool: "fill", label: "Fill", key: "U" },
];
const VISIBILITIES: Visibility[] = ["public", "unlisted", "private"];

interface SaveFields {
  name: string;
  description: string;
  visibility: Visibility;
}

export const editorScreen: ScreenFactory = (ctx) => {
  const root = h("div", { class: "screen editor" });
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

  // Canvas and the controls around it. A room map is never drafted locally.
  const canvas = h("canvas", { class: "editor-canvas", "aria-label": "Map canvas" });
  const lagEl = h("p", { class: "editor-lag", role: "status" });
  const stage = h("div", { class: "editor-stage" }, canvas, lagEl);
  const ctrl = new EditorController(canvas, () => refresh(), !inRoom);
  const observer = new ResizeObserver(() => {
    if (stage.isConnected) ctrl.resize();
  });
  observer.observe(stage);

  const toolButtons = new Map<Tool, HTMLButtonElement>();
  const toolRow = h(
    "div",
    { class: "editor-tools", role: "toolbar", "aria-label": "Tools" },
    TOOLS.map(({ tool, label, key }) => {
      const btn = h("button", { type: "button", class: "editor-tool", title: `Hotkey ${key}`, onclick: () => ctrl.setTool(tool) }, `${label} (${key})`);
      toolButtons.set(tool, btn);
      return btn;
    }),
  );

  const undoBtn = h("button", { type: "button", onclick: () => ctrl.undo() }, "Undo");
  const redoBtn = h("button", { type: "button", onclick: () => ctrl.redo() }, "Redo");
  const deleteBtn = h("button", { type: "button", onclick: () => ctrl.removeSelection() }, "Delete");
  const mergeBtn = h("button", { type: "button", title: "Join the selected bodies into one", onclick: () => ctrl.mergeSelected() }, "Merge shapes");
  const zoomOutBtn = h("button", { type: "button", title: "Zoom out", onclick: () => ctrl.zoomBy(0.8) }, "Zoom out");
  const zoomInBtn = h("button", { type: "button", title: "Zoom in", onclick: () => ctrl.zoomBy(1.25) }, "Zoom in");
  const resetZoomBtn = h("button", { type: "button", onclick: () => ctrl.resetZoom() }, "Reset zoom");
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
  const testBtn = h("button", { type: "button", class: "primary", onclick: () => void playTest() }, "Test play");
  const actions = h(
    "div",
    { class: "editor-actions" },
    undoBtn,
    redoBtn,
    deleteBtn,
    mergeBtn,
    zoomOutBtn,
    zoomInBtn,
    resetZoomBtn,
    colourInput,
    useRoomBtn,
    testBtn,
  );

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
  const favList = h("div", { class: "editor-list" });
  const codeBox = h("textarea", { class: "editor-code", readonly: "", rows: 3, "aria-label": "Map code" });
  const pasteInput = h("input", { type: "text", placeholder: "Paste a map code", "aria-label": "Map code to open" });
  const fileInput = h("input", { type: "file", accept: ".json,application/json", "aria-label": "Open map file" });
  const saveBox = h("div", { class: "editor-save" });
  const menuBody = h(
    "div",
    { class: "editor-menu-body" },
    h(
      "section",
      null,
      h("h2", null, "Map"),
      h(
        "div",
        { class: "editor-row" },
        h("button", { type: "button", onclick: () => newMap() }, "New map"),
        h("button", { type: "button", onclick: () => downloadMap(ctrl.doc) }, "Download"),
      ),
      h("label", { class: "editor-field" }, h("span", null, "Open a file"), fileInput),
    ),
    h("section", null, h("h2", null, "Built-in maps"), builtinList),
    h("section", null, h("h2", null, "My maps"), mineList),
    h("section", null, h("h2", null, "Favourites"), favList),
    h(
      "section",
      null,
      h("h2", null, "Paste code"),
      h("div", { class: "editor-row" }, pasteInput, h("button", { type: "button", onclick: () => void openCode(pasteInput.value, "pasted code") }, "Open")),
    ),
    h(
      "section",
      null,
      h("h2", null, "Share code"),
      codeBox,
      h("div", { class: "editor-row" }, h("button", { type: "button", onclick: () => void copyCode() }, "Copy code")),
    ),
    h("section", null, h("h2", null, "Save to library"), saveBox),
  );
  const menu = h(
    "div",
    { class: "editor-menu" },
    h("div", { class: "editor-top" }, h("span", { class: "editor-title" }, "Map"), h("button", { type: "button", onclick: () => toggleMenu(false) }, "Close")),
    menuBody,
  );
  menu.hidden = true;

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
    mergeBtn.disabled = ctrl.sel.filter((r) => r.kind === "body").length < 2;
    const shapes = ctrl.physicsShapes;
    lagEl.textContent = `${shapes} physics shapes: ${lagVerdict(shapes)}`;
    hintEl.textContent = ctrl.message || ctrl.hint;
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
    if (on) refreshMenu();
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
    builtinList.replaceChildren(h("p", { class: "status" }, "Loading maps…"));
    try {
      const maps = await ctx.maps();
      builtinList.replaceChildren(
        ...maps.map((m) => h("button", { type: "button", class: "editor-item", onclick: () => void openCode(m.code, m.name) }, m.name)),
      );
    } catch (err) {
      builtinList.replaceChildren(h("p", { class: "status error" }, errorText(err)));
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
    if (result.status === "rejected") return [h("p", { class: "status error" }, errorText(result.reason))];
    if (result.value.length === 0) return [h("p", { class: "status" }, empty)];
    return result.value.map((m) =>
      h("button", { type: "button", class: "editor-item", onclick: () => openLibraryMap(m, owned) }, `${m.name} · ${VISIBILITY_LABELS[m.visibility]}`),
    );
  }

  async function showMine(): Promise<void> {
    if (!ctx.store.state.account) {
      mineList.replaceChildren(signInPrompt(ctx, "Sign in to open your saved maps."));
      favList.replaceChildren(h("p", { class: "status" }, "Sign in to see your favourites."));
      return;
    }
    mineList.replaceChildren(h("p", { class: "status" }, "Loading your maps…"));
    favList.replaceChildren(h("p", { class: "status" }, "Loading favourites…"));
    const [mine, favs] = await Promise.allSettled([listMine(), listFavourites()]);
    mineList.replaceChildren(...libraryButtons(mine, "No saved maps yet.", true));
    favList.replaceChildren(...libraryButtons(favs, "No favourites yet.", false));
  }

  function showSave(): void {
    if (!ctx.store.state.account) {
      saveBox.replaceChildren(signInPrompt(ctx, "Sign in to save maps to your library."));
      return;
    }
    const current = libraryMap;
    const name = h("input", { type: "text", placeholder: "Map name", maxlength: 40, "aria-label": "Map name" });
    name.value = current?.name ?? "";
    const description = h("textarea", { rows: 3, placeholder: "What is the map about?", "aria-label": "Map description" });
    description.value = current?.description ?? "";
    const visibility = h("select", { "aria-label": "Visibility" }, VISIBILITIES.map((v) => h("option", { value: v }, VISIBILITY_LABELS[v])));
    visibility.value = current?.visibility ?? "public";
    const fields = (): SaveFields => ({ name: name.value, description: description.value, visibility: visibility.value as Visibility });
    const buttons: HTMLButtonElement[] = [];
    if (current) {
      const overwrite = h("button", { type: "button", class: "primary" }, "Save");
      overwrite.addEventListener("click", () => void saveToLibrary("overwrite", fields(), overwrite));
      const asNew = h("button", { type: "button" }, "Save as new");
      asNew.addEventListener("click", () => void saveToLibrary("new", fields(), asNew));
      buttons.push(overwrite, asNew);
    } else {
      const save = h("button", { type: "button", class: "primary" }, "Save to library");
      save.addEventListener("click", () => void saveToLibrary("new", fields(), save));
      buttons.push(save);
    }
    saveBox.replaceChildren(
      h("label", { class: "editor-field" }, h("span", null, "Name"), name),
      h("label", { class: "editor-field" }, h("span", null, "Description"), description),
      h("label", { class: "editor-field" }, h("span", null, "Visibility"), visibility),
      h("p", { class: "status" }, "Public maps appear in the library after approval."),
      h("div", { class: "editor-row" }, ...buttons),
    );
  }

  /** `overwrite` updates the open library map (after a confirm); `new` uploads a copy. */
  async function saveToLibrary(mode: "new" | "overwrite", f: SaveFields, btn: HTMLButtonElement): Promise<void> {
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
      ctx.toast("Saved to your library");
      void showMine();
      showSave();
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
    showSave();
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
