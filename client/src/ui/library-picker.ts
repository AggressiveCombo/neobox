// Map picker for a room's host: the library's tabs and map cards in a dialog. Picking a
// map hands its code to `onPick` and closes the dialog; Escape or the scrim closes it too.

import { errorText, LIBRARY_PAGE_SIZE, type LibraryMap } from "../account";
import type { AppCtx } from "../ctx";
import { h } from "./dom";
import { icon } from "./icons";
import { openModal } from "./kit";
import { loadTab, mapCard, mapCode, tabBar, type LibraryTab } from "./map-list";

const SEARCH_DELAY_MS = 300;

export interface PickedMap {
  id: number;
  name: string;
  code: string;
}

/** Open the map picker over the current screen. Returns a function that closes it. */
export function openLibraryPicker(ctx: AppCtx, onPick: (map: PickedMap) => void): () => void {
  let tab: LibraryTab = "browse";
  let q = "";
  let page = 0;
  let more = false;
  let maps: LibraryMap[] = [];
  let seq = 0;
  let searchTimer: ReturnType<typeof setTimeout> | undefined;

  const status = h("p", { class: "status", role: "status", "aria-live": "polite" });
  const tabsHost = h("div", { class: "picker-tabs" });
  const searchInput = h("input", {
    type: "search",
    placeholder: "Search maps",
    "aria-label": "search maps",
    autocomplete: "off",
    spellcheck: "false",
    maxlength: 50,
    oninput: onSearch,
  });
  const toolbar = h("div", { class: "library-search" }, icon("search", 18), searchInput);
  const grid = h("ul", { class: "map-grid", "aria-label": "maps" });
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
    icon("chevron-down", 18),
    "More maps",
  );

  const modal = openModal({
    title: "Pick a map",
    body: [tabsHost, toolbar, status, grid, moreBtn],
    onclose: () => {
      clearTimeout(searchTimer);
      seq += 1;
    },
  });
  modal.dialog.classList.add("map-picker");

  function onSearch(): void {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => {
      searchTimer = undefined;
      q = searchInput.value.trim();
      reload();
    }, SEARCH_DELAY_MS);
  }

  function reload(): void {
    page = 0;
    void load(false);
  }

  async function load(append: boolean): Promise<void> {
    const req = ++seq;
    if (tab !== "browse" && ctx.store.state.account === null) {
      maps = [];
      more = false;
      grid.replaceChildren();
      moreBtn.hidden = true;
      status.textContent = "Sign in to see these maps.";
      return;
    }
    status.textContent = "Loading…";
    try {
      const got = await loadTab(tab, { sort: "hot", q, page });
      if (req !== seq) return;
      maps = append ? [...maps, ...got] : got;
      more = tab === "browse" && got.length === LIBRARY_PAGE_SIZE;
    } catch (err) {
      if (req === seq) status.textContent = errorText(err);
      return;
    }
    grid.replaceChildren(...maps.map((m) => mapCard(ctx, m, () => void pick(m))));
    status.textContent = maps.length === 0 ? (q === "" ? "No maps here yet." : "No maps match that search.") : "";
    moreBtn.hidden = !more;
  }

  async function pick(map: LibraryMap): Promise<void> {
    status.textContent = "Loading map…";
    try {
      const code = await mapCode(map.id);
      modal.close();
      onPick({ id: map.id, name: map.name, code });
    } catch (err) {
      status.textContent = errorText(err);
    }
  }

  function paintTabs(): void {
    tabsHost.replaceChildren(
      tabBar(tab, (next) => {
        if (next === tab) return;
        tab = next;
        maps = [];
        paintTabs();
        reload();
      }),
    );
    toolbar.hidden = tab !== "browse";
  }

  paintTabs();
  reload();
  return modal.close;
}
