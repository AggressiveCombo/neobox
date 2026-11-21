// Map library: browse public maps (hot, top rated, new, most played, staff picks), your own
// maps (upload, edit, delete) and favourites. A map opens in a dialog with its Fastest Times,
// where it can be voted on, starred, copied, reported, or played in a room. Browsing works
// signed out; the other tabs and voting need an account.

import {
  deleteMap,
  errorText,
  favouriteMap,
  getMap,
  LIBRARY_PAGE_SIZE,
  listMakers,
  listRecords,
  returnScreen,
  updateMap,
  uploadMap,
  voteMap,
  type LibraryMap,
  type LibrarySort,
  type MapRecord,
  type Visibility,
} from "../../account";
import { sendReport } from "../../api";
import type { AppCtx, ScreenFactory } from "../../ctx";
import type { AppState } from "../../state";
import { h, type Child } from "../dom";
import { icon } from "../icons";
import { confirmDialog, field, openModal, page, pageHead, seg, uid, type SegOption } from "../kit";
import {
  SORT_LABELS,
  VISIBILITY_LABELS,
  loadTab,
  mapCard,
  mapCode,
  mapState,
  plural,
  previewCode,
  previewThumb,
  tabBar,
  type LibraryTab,
} from "../map-list";
import { signInPrompt } from "./account";

const SEARCH_DELAY_MS = 300;
const PREVIEW_DELAY_MS = 300;
const ROOM_WAIT_MS = 15_000;
const ROOM_MAX_PLAYERS = 8;
const TICKS_PER_SECOND = 30;
const SORTS: readonly (readonly [LibrarySort, string])[] = (["hot", "top", "new", "plays", "picks"] as const).map(
  (s) => [s, SORT_LABELS[s]] as const,
);
const VISIBILITY_OPTIONS: SegOption<Visibility>[] = (["public", "unlisted", "private"] as const).map((v) => ({
  value: v,
  label: VISIBILITY_LABELS[v],
}));

type ReportReason = "Offensive" | "Broken" | "Stolen" | "Other";
const REPORT_OPTIONS: SegOption<ReportReason>[] = (["Offensive", "Broken", "Stolen", "Other"] as const).map((r) => ({
  value: r,
  label: r,
}));

/** The map dialog: the map as last fetched, and the element its counts and actions are painted into. */
interface Detail {
  id: number;
  map: LibraryMap;
  info: HTMLElement;
  close(): void;
}

/** The Fastest Times table, fastest first. */
function recordsTable(rows: MapRecord[]): HTMLElement {
  return h(
    "table",
    { class: "data" },
    h(
      "thead",
      null,
      h("tr", null, h("th", { scope: "col" }, "Rank"), h("th", { scope: "col" }, "Name"), h("th", { scope: "col" }, "Time"), h("th", { scope: "col" }, "Date")),
    ),
    h(
      "tbody",
      null,
      rows.map((r) =>
        h(
          "tr",
          null,
          h("td", { class: "num" }, String(r.rank)),
          h("td", null, r.name),
          h("td", { class: "num" }, (r.ticks / TICKS_PER_SECOND).toFixed(2) + " s"),
          h("td", null, new Date(r.date * 1000).toLocaleDateString()),
        ),
      ),
    ),
  );
}

/** A room name the server accepts (letters, digits, spaces, underscores; 15 characters), from a map name. */
function roomName(mapName: string): string {
  const clean = mapName.replace(/[^A-Za-z0-9 _]/g, "").trim().slice(0, 15).trim();
  return clean === "" ? "Library room" : clean;
}

export const libraryScreen: ScreenFactory = (ctx) => {
  const { store } = ctx;
  let tab: LibraryTab = "browse";
  let sort: LibrarySort = "hot";
  let q = "";
  let pageNo = 0;
  let more = false;
  let maps: LibraryMap[] = [];
  let seq = 0;
  let busy = false;
  let detail: Detail | null = null;
  let searchTimer: number | undefined;
  let previewTimer: number | undefined;

  const status = h("p", { class: "status", role: "status", "aria-live": "polite" });
  const emptyBox = h("div", { class: "library-empty", hidden: true });
  const scopeHost = h("div");
  const gate = h("div", { hidden: true });

  const searchInput = h("input", {
    type: "search",
    placeholder: "Search maps",
    "aria-label": "search maps",
    autocomplete: "off",
    spellcheck: "false",
    maxlength: 50,
    oninput: onSearch,
  });
  const searchWrap = h("div", { class: "library-search" }, icon("search", 18), searchInput);
  const sortSelect = h(
    "select",
    { "aria-label": "sort maps", onchange: () => selectSort(sortSelect.value as LibrarySort) },
    SORTS.map(([value, label]) => h("option", { value }, label)),
  );
  const sortWrap = h("div", { class: "library-sort" }, icon("arrow-up-down", 18), sortSelect);
  const uploadBtn = h("button", { type: "button", class: "primary", onclick: () => openUpload() }, icon("upload", 18), "Upload a map");
  const toolbar = h("div", { class: "library-toolbar" }, searchWrap, sortWrap, uploadBtn);

  const grid = h("ul", { class: "map-grid", "aria-label": "maps" });
  const moreBtn = h(
    "button",
    {
      type: "button",
      class: "library-more",
      hidden: true,
      onclick: () => {
        pageNo += 1;
        void load(true);
      },
    },
    icon("chevron-down", 18),
    "More maps",
  );

  const makersList = h("ol", { class: "library-makers-list" });
  const makersStatus = h("p", { class: "status", role: "status", "aria-live": "polite" });
  const makers = h(
    "section",
    { class: "library-makers panel", "aria-label": "top makers this week", hidden: true },
    h("h2", null, icon("trophy", 20), "Top makers this week"),
    makersStatus,
    makersList,
  );

  function needAccount(what: string): boolean {
    if (store.state.account !== null) return false;
    ctx.toast(`Sign in to ${what}.`, "error");
    return true;
  }

  function paintChrome(): void {
    scopeHost.replaceChildren(tabBar(tab, selectTab));
    const browse = tab === "browse";
    const signedOut = tab !== "browse" && store.state.account === null;
    sortSelect.value = sort;
    searchWrap.hidden = !browse;
    sortWrap.hidden = !browse;
    uploadBtn.hidden = tab !== "mine" || signedOut;
    toolbar.hidden = searchWrap.hidden && uploadBtn.hidden;
    makers.hidden = !browse;
    grid.hidden = signedOut;
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

  function selectSort(next: LibrarySort): void {
    if (next === sort) return;
    sort = next;
    paintChrome();
    reload();
  }

  function onSearch(): void {
    clearTimeout(searchTimer);
    searchTimer = window.setTimeout(() => {
      searchTimer = undefined;
      q = searchInput.value.trim();
      reload();
    }, SEARCH_DELAY_MS);
  }

  function reload(): void {
    pageNo = 0;
    void load(false);
  }

  async function loadMakers(): Promise<void> {
    try {
      const got = await listMakers();
      makersList.replaceChildren(
        ...got.map((m) => h("li", null, h("span", { class: "maker-name" }, icon("circle-user", 16), m.name), h("span", { class: "maker-score num" }, String(m.score)))),
      );
      makersStatus.textContent = got.length === 0 ? "Nobody has earned votes or plays this week yet." : "";
    } catch (err) {
      makersStatus.textContent = errorText(err);
    }
  }

  async function load(append: boolean): Promise<void> {
    const req = ++seq;
    if (tab !== "browse" && store.state.account === null) {
      maps = [];
      more = false;
      grid.replaceChildren();
      emptyBox.hidden = true;
      status.textContent = "";
      return;
    }
    status.textContent = "Loading…";
    emptyBox.hidden = true;
    try {
      const got = await loadTab(tab, { sort, q, page: pageNo });
      if (req !== seq) return;
      more = tab === "browse" && got.length === LIBRARY_PAGE_SIZE;
      maps = append ? [...maps, ...got] : got;
    } catch (err) {
      if (req === seq) status.textContent = errorText(err);
      return;
    }
    paintList(!append);
  }

  function emptyText(): string {
    if (tab === "mine") return "No maps yet. Upload one; it shows in Browse once an admin approves it.";
    if (tab === "favourites") return "No favourites yet. Star a map to keep it here.";
    return q === "" ? "No maps yet. Maps show here once an admin approves them." : `No maps match "${q}".`;
  }

  /** Cards by map, kept while the map's content and tab are unchanged, so a repaint keeps their drawn previews. */
  const cards = new Map<number, { key: string; el: HTMLElement }>();

  /** Paint the cards. `fresh` (a new list, not a refresh) lets the cards rise in once. */
  function paintList(fresh = false): void {
    grid.classList.toggle("enter", fresh);
    const els = maps.map((m) => {
      const key = `${tab}|${JSON.stringify(m)}`;
      const cached = cards.get(m.id);
      if (cached?.key === key) return cached.el;
      const el = mapCard(ctx, m, () => openDetail(m), tab === "mine");
      cards.set(m.id, { key, el });
      return el;
    });
    const shown = new Set(maps.map((m) => m.id));
    for (const id of cards.keys()) if (!shown.has(id)) cards.delete(id);
    const have = Array.from(grid.children);
    if (!fresh && have.every((el, i) => el === els[i])) grid.append(...els.slice(have.length));
    else grid.replaceChildren(...els);
    status.textContent = "";
    const empty = maps.length === 0;
    emptyBox.replaceChildren(...(empty ? [icon(tab === "browse" && q !== "" ? "search-x" : "inbox", 40), h("p", null, emptyText())] : []));
    emptyBox.hidden = !empty;
    moreBtn.hidden = !more;
  }

  /** Reload one map's counts and flags. On the favourites tab an un-starred map leaves the list. */
  async function refresh(id: number): Promise<void> {
    const fresh = await getMap(id);
    const keep = tab !== "favourites" || fresh.favourite === true;
    maps = maps.flatMap((m) => (m.id !== id ? [m] : keep ? [fresh] : []));
    paintList();
    if (detail?.id === id) {
      detail.map = fresh;
      paintInfo();
    }
  }

  /** Run a map action, then show the map's new state. Failures go to a toast. */
  async function act(run: () => Promise<void>, id: number): Promise<boolean> {
    try {
      await run();
      await refresh(id);
      return true;
    } catch (err) {
      ctx.toast(errorText(err), "error");
      return false;
    }
  }

  async function vote(map: LibraryMap, v: 1 | -1): Promise<void> {
    if (needAccount("vote")) return;
    const next = map.my_vote === v ? 0 : v;
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

  /** The Fastest Times of a library map: the table, or "No Records" before anyone has raced it. */
  function recordsSection(id: number): HTMLElement {
    const text = h("p", { class: "status", role: "status", "aria-live": "polite" }, "Fetching…");
    const body = h("div");
    const section = h("section", { class: "map-records" }, h("h3", null, icon("trophy", 20), "Fastest Times"), text, body);
    listRecords(id).then(
      (rows) => {
        if (!section.isConnected) return;
        if (rows.length === 0) {
          text.textContent = "No Records";
          return;
        }
        text.textContent = "";
        body.replaceChildren(recordsTable(rows));
      },
      (err: unknown) => {
        if (section.isConnected) text.textContent = errorText(err);
      },
    );
    return section;
  }

  /** The play action for the room the viewer is in: the host sets the map; a new room is made otherwise. */
  function roomAction(map: LibraryMap): HTMLElement | null {
    const { room, myId } = store.state;
    if (room !== null) {
      const host = room.quick === null && room.players.some((p) => p.id === myId && p.host);
      if (!host) return h("p", { class: "status" }, "Only the room's host can change the room's map.");
      return h("button", { type: "button", class: "primary", onclick: () => useInRoom(map) }, icon("play", 18), "Use in my room");
    }
    return h("button", { type: "button", class: "primary", onclick: () => playInNewRoom(map) }, icon("play", 18), "Play in a new room");
  }

  function useInRoom(map: LibraryMap): void {
    ctx.send({ t: "set_library_map", id: map.id });
    detail?.close();
    ctx.toast(`${map.name} is the room's map.`);
    store.set({ screen: returnScreen(store.state) });
  }

  function playInNewRoom(map: LibraryMap): void {
    // The server answers with the new room's state, which moves the app to the room screen;
    // the map is set then. Give up waiting if the room never arrives.
    const unsubscribe = store.subscribe((s) => {
      if (s.room === null) return;
      clearTimeout(timer);
      unsubscribe();
      ctx.send({ t: "set_library_map", id: map.id });
    });
    const timer = setTimeout(unsubscribe, ROOM_WAIT_MS);
    ctx.send({ t: "create_room", name: roomName(map.name), password: null, max_players: ROOM_MAX_PLAYERS, public: true });
    detail?.close();
  }

  function openDetail(map: LibraryMap): void {
    const info = h("div", { class: "map-info" });
    const body: Child[] = [previewThumb(ctx, map.id, "detail-thumb"), info];
    if (store.state.account?.name === map.author) body.push(ownSection(map));
    body.push(recordsSection(map.id));
    const modal = openModal({
      title: map.name,
      body,
      onclose: () => {
        detail = null;
      },
    });
    modal.dialog.classList.add("map-dialog");
    detail = { id: map.id, map, info, close: modal.close };
    paintInfo();
  }

  /** The counts, description, actions and report link of the open map. Repainted after every change. */
  function paintInfo(): void {
    if (detail === null) return;
    const { map, info } = detail;
    const own = store.state.account?.name === map.author;
    const up = map.my_vote === 1;
    const down = map.my_vote === -1;
    const starred = map.favourite === true;
    // the server refuses votes on your own map; a guest has to sign in first
    const voteOff = own || store.state.account === null;
    const voteTitle = own ? "You can't vote on your own map" : voteOff ? "Sign in to vote." : undefined;
    info.replaceChildren(
      h("p", { class: "map-byline" }, `by ${map.author}`, map.pick ? h("span", { class: "chip" }, icon("award", 14), "Staff pick") : null),
      ...(own ? [h("p", { class: "map-state" }, mapState(map))] : []),
      h("p", { class: "map-desc" }, map.description !== "" ? map.description : "No description."),
      h("p", { class: "map-stats num" }, icon("thumbs-up", 14), plural(map.votes, "vote"), " · ", icon("play", 14), plural(map.plays, "play")),
      h(
        "div",
        { class: "map-actions" },
        h(
          "button",
          {
            type: "button",
            "aria-pressed": up ? "true" : "false",
            disabled: voteOff,
            title: voteTitle,
            onclick: () => void vote(map, 1),
          },
          icon("thumbs-up", 18),
          "Upvote",
        ),
        h(
          "button",
          {
            type: "button",
            "aria-pressed": down ? "true" : "false",
            disabled: voteOff,
            title: voteTitle,
            onclick: () => void vote(map, -1),
          },
          icon("thumbs-down", 18),
          "Downvote",
        ),
        h(
          "button",
          { type: "button", "aria-pressed": starred ? "true" : "false", onclick: () => void toggleFavourite(map) },
          icon("star", 18),
          starred ? "Starred" : "Star",
        ),
        h("button", { type: "button", onclick: () => void copyCode(map) }, icon("copy", 18), "Copy code"),
      ),
      h("div", { class: "map-play" }, roomAction(map)),
      ...(own ? [] : [h("button", { type: "button", class: "quiet map-report", onclick: () => openReport(map) }, icon("flag", 18), "Report map")]),
    );
  }

  /** Owner's controls, folded away: description, visibility, save and delete. */
  function ownSection(map: LibraryMap): HTMLElement {
    let visibility = map.visibility;
    const desc = h("textarea", {
      rows: 3,
      maxlength: 300,
      placeholder: "What is the map about? (optional)",
      autocomplete: "off",
      spellcheck: "false",
    });
    desc.value = map.description;
    const visSeg = seg("Visibility", VISIBILITY_OPTIONS, map.visibility, (v) => {
      visibility = v;
    });
    const save = h(
      "button",
      {
        type: "button",
        onclick: async () => {
          const patch: { description?: string; visibility?: Visibility } = {};
          const text = desc.value.trim();
          if (text !== map.description) patch.description = text;
          if (visibility !== map.visibility) patch.visibility = visibility;
          if (Object.keys(patch).length === 0) {
            ctx.toast("No changes to save.");
            return;
          }
          if (await act(() => updateMap(map.id, patch), map.id)) ctx.toast("Map saved.");
        },
      },
      icon("save", 18),
      "Save changes",
    );
    const remove = h(
      "button",
      {
        type: "button",
        class: "danger",
        onclick: async () => {
          const ok = await confirmDialog({
            title: `Delete "${map.name}"?`,
            message: "This cannot be undone.",
            action: "Delete map",
          });
          if (!ok) return;
          try {
            await deleteMap(map.id);
            maps = maps.filter((m) => m.id !== map.id);
            paintList();
            detail?.close();
            ctx.toast("Map deleted.");
          } catch (err) {
            ctx.toast(errorText(err), "error");
          }
        },
      },
      icon("trash-2", 18),
      "Delete map",
    );
    return h(
      "details",
      { class: "map-owner" },
      h("summary", null, icon("pencil", 18), "Edit your map"),
      h(
        "div",
        { class: "map-owner-body" },
        field("Description", desc),
        h("div", { class: "field" }, h("span", { class: "field-label" }, "Visibility"), visSeg.el),
        h("p", { class: "field-hint" }, "Public maps show in Browse once an admin approves them."),
        h("div", { class: "actions" }, save, remove),
      ),
    );
  }

  function openReport(map: LibraryMap): void {
    let reason: ReportReason = "Offensive";
    let modal: { close(): void } | undefined;
    let sending = false;
    const formId = uid("report");
    const details = h("textarea", { rows: 3, maxlength: 300, autocomplete: "off", spellcheck: "false" });
    const formError = h("p", { class: "field-error", role: "alert" });
    const send = h("button", { type: "submit", class: "primary", form: formId }, icon("send", 18), "Send report");
    const cancel = h("button", { type: "button", onclick: () => modal?.close() }, icon("x", 18), "Cancel");
    const form = h(
      "form",
      {
        id: formId,
        class: "modal-form",
        onsubmit: async (e: Event) => {
          e.preventDefault();
          if (sending) return;
          sending = true;
          send.disabled = true;
          formError.textContent = "";
          const extra = details.value.trim();
          try {
            await sendReport({ kind: "map", map: map.id, reason: extra === "" ? reason : `${reason}: ${extra}` });
            modal?.close();
            ctx.toast("Thanks. An admin will look at this map.");
          } catch (err) {
            formError.textContent = errorText(err);
          } finally {
            sending = false;
            send.disabled = false;
          }
        },
      },
      h("p", { class: "field-hint" }, `Tell an admin what is wrong with "${map.name}".`),
      h("div", { class: "field" }, h("span", { class: "field-label" }, "Reason"), seg("Reason", REPORT_OPTIONS, reason, (v) => {
        reason = v;
      }).el),
      field("Details (optional)", details),
      formError,
    );
    modal = openModal({ title: "Report map", body: [form], actions: [cancel, send] });
  }

  function openUpload(): void {
    if (needAccount("upload maps")) return;
    let visibility: Visibility = "public";
    let modal: { close(): void } | undefined;
    const formId = uid("upload");
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
      autocomplete: "off",
      spellcheck: "false",
    });
    const codeInput = h("textarea", {
      rows: 4,
      placeholder: "Paste a map code",
      "aria-label": "map code",
      autocomplete: "off",
      spellcheck: "false",
      oninput: onCodeInput,
    });
    const previewCanvas = h("canvas", { "aria-hidden": "true" });
    const previewBox = h("div", { class: "map-preview", hidden: true }, previewCanvas);
    const formError = h("p", { class: "field-error", role: "alert" });
    const submit = h("button", { type: "submit", class: "primary", form: formId }, icon("upload", 18), "Upload map");
    const cancel = h("button", { type: "button", onclick: () => modal?.close() }, icon("x", 18), "Cancel");

    function onCodeInput(): void {
      clearTimeout(previewTimer);
      previewTimer = window.setTimeout(() => {
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
      submit.disabled = true;
      formError.textContent = "";
      try {
        await uploadMap({ name, description: descInput.value.trim(), code, visibility });
        modal?.close();
        ctx.toast(visibility === "public" ? "Map uploaded. It shows once an admin approves it." : "Map uploaded.");
        if (tab === "mine") reload();
      } catch (err) {
        formError.textContent = errorText(err);
      } finally {
        busy = false;
        submit.disabled = false;
      }
    }

    const form = h(
      "form",
      { id: formId, class: "modal-form", onsubmit: onUpload },
      field("Name", nameInput),
      field("Description", descInput),
      field("Map code", codeInput),
      previewBox,
      h("div", { class: "field" }, h("span", { class: "field-label" }, "Visibility"), seg("Visibility", VISIBILITY_OPTIONS, visibility, (v) => {
        visibility = v;
      }).el),
      h("p", { class: "field-hint" }, "Public maps show in Browse once an admin approves them."),
      formError,
    );
    modal = openModal({
      title: "Upload a map",
      body: [form],
      actions: [cancel, submit],
      onclose: () => clearTimeout(previewTimer),
    });
  }

  /** What the detail's play action depends on: the room and whether the viewer hosts it. Room broadcasts that leave it unchanged do not repaint the detail. */
  function roomKey(state: AppState): string {
    const { room, myId } = state;
    if (room === null) return "";
    const host = room.quick === null && room.players.some((p) => p.id === myId && p.host);
    return `${room.code}|${host}`;
  }

  const el = page(
    "library-page",
    pageHead({ title: "Library", back: () => store.set({ screen: returnScreen(store.state) }) }),
    scopeHost,
    toolbar,
    gate,
    status,
    emptyBox,
    h("div", { class: "library-layout" }, h("div", { class: "library-main" }, grid, moreBtn), makers),
  );

  paintChrome();
  reload();
  void loadMakers();

  return {
    el,
    update(state: AppState, prev: AppState) {
      if (state.account?.id !== prev.account?.id) {
        paintChrome();
        reload();
      }
      if (detail !== null && roomKey(state) !== roomKey(prev)) paintInfo();
    },
    destroy() {
      clearTimeout(searchTimer);
      clearTimeout(previewTimer);
      seq += 1;
      detail?.close();
      el.remove();
    },
  };
};
