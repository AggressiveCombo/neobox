// Map picker for rooms, the editor and practice: the library's tabs plus Hitbox.io
// map search in one dialog. Clicking a map imports its code via `onPick` and closes
// the dialog immediately; Escape or the scrim closes it too.

import { errorText, LIBRARY_PAGE_SIZE, type LibraryMap } from "../account";
import { fetchHitboxMaps, type HitboxMap, type HitboxSearchBy, type HitboxSort } from "../api";
import type { AppCtx } from "../ctx";
import { h } from "./dom";
import { icon } from "./icons";
import { openModal } from "./kit";
import {
  HITBOX_BROWSE_SORTS,
  HITBOX_BY_OPTIONS,
  HITBOX_SEARCH_SORTS,
  hitboxMapCard,
  loadTab,
  mapCard,
  mapCode,
  tabBar,
  type LibraryTab,
} from "./map-list";

const SEARCH_DELAY_MS = 300;

export interface PickedMap {
  /** Library map id, or null when imported from Hitbox.io. */
  id: number | null;
  name: string;
  code: string;
}

/** Open the map picker over the current screen. Returns a function that closes it. */
export function openLibraryPicker(
  ctx: AppCtx,
  onPick: (map: PickedMap) => void,
  initialTab: LibraryTab = "browse",
): () => void {
  let tab: LibraryTab = initialTab;
  let q = "";
  let page = 0;
  let hitboxOffset = 0;
  let hitboxSort: HitboxSort = "hot";
  let hitboxBy: HitboxSearchBy = "both";
  let more = false;
  let maps: LibraryMap[] = [];
  let hitboxMaps: HitboxMap[] = [];
  let seq = 0;
  let searchTimer: ReturnType<typeof setTimeout> | undefined;
  let inflight: AbortController | null = null;

  const status = h("p", { class: "status", role: "status", "aria-live": "polite" });
  const tabsHost = h("div", { class: "picker-tabs" });
  const searchInput = h("input", {
    type: "search",
    placeholder: "Search maps",
    "aria-label": "Search maps",
    autocomplete: "off",
    spellcheck: "false",
    maxlength: 50,
    oninput: onSearch,
  });
  const searchWrap = h("div", { class: "library-search" }, icon("search", 18), searchInput);
  const sortSelect = h("select", {
    "aria-label": "Sort Hitbox.io maps",
    onchange: () => {
      hitboxSort = sortSelect.value as HitboxSort;
      reload();
    },
  });
  const sortWrap = h("div", { class: "library-sort" }, icon("arrow-up-down", 18), sortSelect);
  const bySelect = h(
    "select",
    {
      "aria-label": "Search in",
      onchange: () => {
        hitboxBy = bySelect.value as HitboxSearchBy;
        reload();
      },
    },
    HITBOX_BY_OPTIONS.map(([value, label]) => h("option", { value }, label)),
  );
  const byWrap = h("div", { class: "library-sort" }, icon("sliders-horizontal", 18), bySelect);
  const toolbar = h("div", { class: "library-toolbar" }, searchWrap, sortWrap, byWrap);
  const grid = h("ul", { class: "map-grid", "aria-label": "maps" });
  const moreBtn = h(
    "button",
    {
      type: "button",
      class: "library-more",
      hidden: true,
      onclick: () => {
        if (tab === "hitbox") {
          void load(true);
        } else {
          page += 1;
          void load(true);
        }
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
      inflight?.abort();
      inflight = null;
      seq += 1;
    },
  });
  modal.dialog.classList.add("map-picker");

  function syncHitboxSortOptions(): void {
    const searching = q !== "";
    const opts = searching ? HITBOX_SEARCH_SORTS : HITBOX_BROWSE_SORTS;
    if (!opts.some(([v]) => v === hitboxSort)) {
      hitboxSort = opts[0][0];
    }
    sortSelect.replaceChildren(...opts.map(([value, label]) => h("option", { value }, label)));
    sortSelect.value = hitboxSort;
    byWrap.hidden = tab !== "hitbox" || !searching;
  }

  function syncToolbar(): void {
    const showSearch = tab === "browse" || tab === "hitbox";
    toolbar.hidden = !showSearch;
    const isHitbox = tab === "hitbox";
    searchInput.placeholder = isHitbox ? "Search Hitbox.io maps" : "Search maps";
    sortWrap.hidden = !isHitbox;
    syncHitboxSortOptions();
  }

  function onSearch(): void {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => {
      searchTimer = undefined;
      q = searchInput.value.trim();
      syncToolbar();
      reload();
    }, SEARCH_DELAY_MS);
  }

  function reload(): void {
    page = 0;
    hitboxOffset = 0;
    void load(false);
  }

  async function load(append: boolean): Promise<void> {
    const req = ++seq;
    inflight?.abort();
    inflight = null;

    if (tab === "hitbox") {
      const controller = new AbortController();
      inflight = controller;
      status.textContent = q !== "" ? "Searching Hitbox.io…" : "Loading Hitbox.io maps…";
      if (!append) moreBtn.hidden = true;
      try {
        const res = await fetchHitboxMaps({ q, sort: hitboxSort, by: hitboxBy, offset: hitboxOffset }, controller.signal);
        if (req !== seq) return;
        hitboxMaps = append ? [...hitboxMaps, ...res.maps] : res.maps;
        more = res.more && res.next_offset !== null;
        if (res.next_offset !== null) hitboxOffset = res.next_offset;
      } catch (err) {
        if (req !== seq) return;
        if (err instanceof DOMException && err.name === "AbortError") return;
        status.textContent = errorText(err);
        return;
      } finally {
        if (inflight === controller) inflight = null;
      }
      grid.replaceChildren(...hitboxMaps.map((m) => hitboxMapCard(ctx, m, () => pickHitbox(m))));
      status.textContent = hitboxMaps.length === 0 ? (q === "" ? "No maps found on Hitbox.io." : `No Hitbox.io maps match "${q}".`) : "";
      moreBtn.hidden = !more;
      return;
    }

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

  function pickHitbox(map: HitboxMap): void {
    modal.close();
    onPick({ id: null, name: map.name, code: map.code });
  }

  function paintTabs(): void {
    tabsHost.replaceChildren(
      tabBar(tab, (next) => {
        if (next === tab) return;
        tab = next;
        maps = [];
        hitboxMaps = [];
        grid.replaceChildren();
        paintTabs();
        syncToolbar();
        reload();
      }),
    );
    syncToolbar();
  }

  paintTabs();
  reload();
  return modal.close;
}
