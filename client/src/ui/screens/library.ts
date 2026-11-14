// Map library: browse public maps, your own maps (upload, visibility, delete) and
// favourites. Maps can be voted on, starred and copied as a code for practice or a room.
// Browsing works signed out; the other tabs and voting need an account.

import {
  deleteMap,
  errorText,
  LIBRARY_PAGE_SIZE,
  favouriteMap,
  getMap,
  listMakers,
  returnScreen,
  updateMap,
  uploadMap,
  voteMap,
  type LibraryMap,
  type LibrarySort,
  type MakerScore,
  type Visibility,
} from "../../account";
import type { AppCtx, ScreenFactory } from "../../ctx";
import type { AppState } from "../../state";
import { h, type Child } from "../dom";
import {
  SORT_LABELS,
  VISIBILITY_LABELS,
  loadTab,
  mapCode,
  mapLines,
  previewCode,
  previewThumb,
  tabBar,
  type LibraryTab,
} from "../map-list";
import { signInPrompt } from "./account";

const SEARCH_DELAY_MS = 300;
const PREVIEW_DELAY_MS = 300;
const SORTS: LibrarySort[] = ["new", "hot", "top", "plays", "picks"];
const VISIBILITIES: Visibility[] = ["public", "unlisted", "private"];

export const libraryScreen: ScreenFactory = (ctx) => {
  const { store } = ctx;
  let tab: LibraryTab = "browse";
  let sort: LibrarySort = "new";
  let q = "";
  let page = 0;
  let more = false;
  let maps: LibraryMap[] = [];
  let seq = 0;
  let busy = false;
  let searchTimer: ReturnType<typeof setTimeout> | undefined;
  let previewTimer: ReturnType<typeof setTimeout> | undefined;

  const status = h("p", { class: "status", role: "status", "aria-live": "polite" });
  const tabsHost = h("div");
  const gate = h("div", { hidden: true });

  // Upload form (own maps)
  const nameInput = h("input", {
    type: "text",
    placeholder: "Map name",
    "aria-label": "map name",
    autocomplete: "off",
    spellcheck: "false",
  });
  const descInput = h("textarea", {
    rows: 2,
    maxlength: 300,
    placeholder: "What is the map about? (optional)",
    "aria-label": "map description",
    autocomplete: "off",
    spellcheck: "false",
  });
  const codeInput = h("textarea", {
    rows: 3,
    placeholder: "Paste a map code",
    "aria-label": "map code",
    autocomplete: "off",
    spellcheck: "false",
    oninput: onCodeInput,
  });
  const visSelect = h(
    "select",
    { "aria-label": "visibility" },
    VISIBILITIES.map((v) => h("option", { value: v }, VISIBILITY_LABELS[v])),
  );
  const previewCanvas = h("canvas", { "aria-hidden": "true" });
  const previewBox = h("div", { class: "map-preview", hidden: true }, previewCanvas);
  const formError = h("p", { class: "field-error", role: "alert" });
  const uploadForm = h(
    "form",
    { class: "social-form upload-form", hidden: true, onsubmit: onUpload },
    h("h2", null, "Upload a map"),
    h("label", { class: "field" }, h("span", { class: "field-label" }, "Name"), nameInput),
    h("label", { class: "field" }, h("span", { class: "field-label" }, "Description"), descInput),
    h("label", { class: "field" }, h("span", { class: "field-label" }, "Map code"), codeInput),
    previewBox,
    formError,
    h("label", { class: "field" }, h("span", { class: "field-label" }, "Visibility"), visSelect),
    h(
      "p",
      { class: "status" },
      "Public maps appear in the library once an admin approves them.",
    ),
    h("div", { class: "actions" }, h("button", { type: "submit", class: "primary" }, "Upload")),
  );

  // Browse controls
  const searchInput = h("input", {
    type: "search",
    placeholder: "Search maps",
    "aria-label": "search maps",
    autocomplete: "off",
    spellcheck: "false",
    maxlength: 50,
    oninput: onSearch,
  });
  const sortSelect = h(
    "select",
    { "aria-label": "sort maps", onchange: onSort },
    SORTS.map((s) => h("option", { value: s }, SORT_LABELS[s])),
  );
  const toolbar = h("div", { class: "library-toolbar" }, searchInput, sortSelect);

  // Top makers this week (browse tab only)
  const makersList = h("ol", { class: "library-makers-list" });
  const makersStatus = h("p", { class: "status" });
  const makers = h(
    "section",
    { class: "library-makers", "aria-label": "top makers this week", hidden: true },
    h("h2", null, "Top makers this week"),
    makersStatus,
    makersList,
  );

  const list = h("ul", { class: "map-list", "aria-label": "maps" });
  const moreBtn = h(
    "button",
    {
      type: "button",
      class: "library-more",
      hidden: true,
      onclick: () => {
        page += 1;
        void load(true);
      },
    },
    "More maps",
  );

  function needsSignIn(): boolean {
    return tab !== "browse" && store.state.account === null;
  }

  function needAccount(what: string): boolean {
    if (store.state.account !== null) return false;
    ctx.toast(`Sign in to ${what}.`, "error");
    return true;
  }

  function paintChrome(): void {
    tabsHost.replaceChildren(tabBar(tab, selectTab));
    const signedOut = needsSignIn();
    toolbar.hidden = tab !== "browse";
    makers.hidden = tab !== "browse";
    uploadForm.hidden = tab !== "mine" || signedOut;
    list.hidden = signedOut;
    moreBtn.hidden = true;
    gate.hidden = !signedOut;
    if (signedOut) {
      const text = tab === "mine" ? "Sign in to see and upload your maps." : "Sign in to see your favourite maps.";
      gate.replaceChildren(signInPrompt(ctx, text));
    } else {
      gate.replaceChildren();
    }
  }

  function selectTab(next: LibraryTab): void {
    if (next === tab) return;
    tab = next;
    maps = [];
    paintChrome();
    reload();
  }

  function onSearch(): void {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => {
      searchTimer = undefined;
      q = searchInput.value.trim();
      reload();
    }, SEARCH_DELAY_MS);
  }

  function onSort(): void {
    sort = sortSelect.value as LibrarySort;
    reload();
  }

  function reload(): void {
    page = 0;
    void load(false);
  }

  async function loadMakers(): Promise<void> {
    try {
      const got = await listMakers();
      makersList.replaceChildren(
        ...got.map((m) =>
          h("li", null, h("span", { class: "maker-name" }, m.name), h("span", { class: "maker-score" }, String(m.score))),
        ),
      );
      makersStatus.textContent = got.length === 0 ? "Nobody has earned votes or plays this week yet." : "";
    } catch (err) {
      makersStatus.textContent = errorText(err);
    }
  }

  async function load(append: boolean): Promise<void> {
    const req = ++seq;
    if (needsSignIn()) {
      maps = [];
      more = false;
      list.replaceChildren();
      status.textContent = "";
      return;
    }
    status.textContent = "Loading…";
    try {
      const got = await loadTab(tab, { sort, q, page });
      if (req !== seq) return;
      more = tab === "browse" && got.length === LIBRARY_PAGE_SIZE;
      maps = append ? [...maps, ...got] : got;
    } catch (err) {
      if (req === seq) status.textContent = errorText(err);
      return;
    }
    paintList();
  }

  function emptyText(): string {
    if (tab === "mine") return "You have not uploaded any maps yet.";
    if (tab === "favourites") return "No favourites yet. Star a map to keep it here.";
    return q === "" ? "No maps yet." : "No maps match that search.";
  }

  function paintList(): void {
    list.replaceChildren(...maps.map(card));
    status.textContent = maps.length === 0 ? emptyText() : "";
    moreBtn.hidden = !more;
  }

  /** Reload one map's counts and flags. On the favourites tab an un-starred map leaves the list. */
  async function refresh(id: number): Promise<void> {
    const fresh = await getMap(id);
    const keep = tab !== "favourites" || fresh.favourite === true;
    maps = maps.flatMap((m) => (m.id !== id ? [m] : keep ? [fresh] : []));
    paintList();
  }

  /** Run a map action, then show the map's new state. Failures go to a toast. */
  async function act(run: () => Promise<void>, id: number): Promise<void> {
    try {
      await run();
      await refresh(id);
    } catch (err) {
      ctx.toast(errorText(err), "error");
    }
  }

  async function vote(map: LibraryMap, v: 1 | -1): Promise<void> {
    if (needAccount("vote")) return;
    const next: -1 | 0 | 1 = map.my_vote === v ? 0 : v;
    await act(() => voteMap(map.id, next), map.id);
  }

  async function toggleFavourite(map: LibraryMap): Promise<void> {
    if (needAccount("star maps")) return;
    await act(() => favouriteMap(map.id, map.favourite !== true), map.id);
  }

  async function copyCode(map: LibraryMap): Promise<void> {
    try {
      const code = await mapCode(map.id);
      if (!navigator.clipboard) throw new Error("Copying needs a secure connection.");
      await navigator.clipboard.writeText(code);
      ctx.toast("Map code copied.");
    } catch (err) {
      ctx.toast(errorText(err), "error");
    }
  }

  async function removeMap(map: LibraryMap): Promise<void> {
    if (!confirm(`Delete "${map.name}"? This cannot be undone.`)) return;
    try {
      await deleteMap(map.id);
      maps = maps.filter((m) => m.id !== map.id);
      paintList();
      ctx.toast("Map deleted.");
    } catch (err) {
      ctx.toast(errorText(err), "error");
    }
  }

  async function editDescription(map: LibraryMap): Promise<void> {
    const text = prompt(`Describe "${map.name}" in up to 300 characters.`, map.description);
    if (text === null || text.trim() === map.description) return;
    await act(() => updateMap(map.id, { description: text.trim() }), map.id);
  }

  function visibilitySelect(map: LibraryMap): HTMLSelectElement {
    const select: HTMLSelectElement = h(
      "select",
      {
        "aria-label": "visibility",
        onchange: () => void act(() => updateMap(map.id, { visibility: select.value as Visibility }), map.id),
      },
      VISIBILITIES.map((v) => h("option", { value: v, selected: v === map.visibility }, VISIBILITY_LABELS[v])),
    );
    return select;
  }

  function card(map: LibraryMap): HTMLElement {
    const up = map.my_vote === 1;
    const down = map.my_vote === -1;
    const starred = map.favourite === true;
    // the server refuses votes on your own map
    const own = store.state.account?.name === map.author;
    const voteTitle = own ? "You can't vote on your own map" : undefined;
    const actions: Child[] = [
      h(
        "button",
        {
          type: "button",
          class: up ? "vote on" : "vote",
          "aria-pressed": up ? "true" : "false",
          "aria-label": "Upvote",
          disabled: own,
          title: voteTitle,
          onclick: () => void vote(map, 1),
        },
        "▲",
      ),
      h(
        "button",
        {
          type: "button",
          class: down ? "vote on" : "vote",
          "aria-pressed": down ? "true" : "false",
          "aria-label": "Downvote",
          disabled: own,
          title: voteTitle,
          onclick: () => void vote(map, -1),
        },
        "▼",
      ),
      h(
        "button",
        {
          type: "button",
          class: starred ? "fav on" : "fav",
          "aria-pressed": starred ? "true" : "false",
          onclick: () => void toggleFavourite(map),
        },
        starred ? "Starred" : "Star",
      ),
      h("button", { type: "button", onclick: () => void copyCode(map) }, "Copy code"),
    ];
    if (tab === "mine") {
      actions.push(
        h("button", { type: "button", onclick: () => void editDescription(map) }, "Edit description"),
        visibilitySelect(map),
        h("button", { type: "button", class: "danger", onclick: () => void removeMap(map) }, "Delete"),
      );
    }
    return h(
      "li",
      null,
      h(
        "article",
        { class: "map-card" },
        previewThumb(ctx, map.id),
        h("div", { class: "map-body" }, mapLines(map), h("div", { class: "map-row" }, actions)),
      ),
    );
  }

  function onCodeInput(): void {
    clearTimeout(previewTimer);
    previewTimer = setTimeout(() => {
      previewTimer = undefined;
      void showPreview();
    }, PREVIEW_DELAY_MS);
  }

  async function showPreview(): Promise<void> {
    const code = codeInput.value.trim();
    previewBox.hidden = code === "";
    if (code === "") {
      formError.textContent = "";
      return;
    }
    formError.textContent = (await previewCode(ctx, previewCanvas, code)) ?? "";
  }

  async function onUpload(e: Event): Promise<void> {
    e.preventDefault();
    if (busy) return;
    const name = nameInput.value.trim();
    const code = codeInput.value.trim();
    if (name === "" || code === "") {
      formError.textContent = "Give the map a name and paste its code.";
      return;
    }
    busy = true;
    formError.textContent = "";
    try {
      const visibility = visSelect.value as Visibility;
      await uploadMap({ name, description: descInput.value.trim(), code, visibility });
      nameInput.value = "";
      descInput.value = "";
      codeInput.value = "";
      previewBox.hidden = true;
      ctx.toast(visibility === "public" ? "Map uploaded. It shows once an admin approves it." : "Map uploaded.");
      if (tab === "mine") reload();
    } catch (err) {
      formError.textContent = errorText(err);
    } finally {
      busy = false;
    }
  }

  const back = h(
    "button",
    { type: "button", class: "back", onclick: () => store.set({ screen: returnScreen(store.state) }) },
    "Back",
  );

  const el = h(
    "div",
    { class: "screen social-screen library-screen" },
    h(
      "section",
      { class: "panel" },
      h("header", { class: "social-head" }, back, h("h1", { class: "social-title" }, "Library")),
      tabsHost,
      gate,
      makers,
      uploadForm,
      toolbar,
      status,
      list,
      moreBtn,
    ),
  );

  paintChrome();
  reload();
  void loadMakers();

  return {
    el,
    update(state: AppState, prev: AppState) {
      if (state.account?.id === prev.account?.id) return;
      paintChrome();
      reload();
    },
    destroy() {
      clearTimeout(searchTimer);
      clearTimeout(previewTimer);
      seq += 1;
      el.remove();
    },
  };
};
