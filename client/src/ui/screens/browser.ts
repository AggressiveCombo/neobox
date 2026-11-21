// The Browse rooms screen: join by code, then the open rooms as one list (search, hide full
// rooms; nearest first, friends on top). Create room opens a modal from the page head. Locked
// rooms ask for their password inline; a server that refused a join asks for it in a panel above
// the list.

import type { ScreenFactory } from "../../ctx";
import {
  GAME_MODES,
  MAX_ROOM_NAME_LEN,
  ROOM_MAX_PLAYERS,
  ROOM_MIN_PLAYERS,
  type RoomInfo,
} from "../../protocol";
import { clear, h } from "../dom";
import { countryName, flagUrl, formatDistance, sortRooms } from "../../rooms";
import { field, openModal, page, pageHead, toggle, uid } from "../kit";
import { icon } from "../icons";

const SVG_NS = "http://www.w3.org/2000/svg";
const DEFAULT_MAX_PLAYERS = 8;
/** Room codes: 6 characters from the server's alphabet (no I, O, 0 or 1). */
const ROOM_CODE_RE = /^[A-HJ-NP-Z2-9]{6}$/;
/** YouTube video ids: 11 characters from the URL-safe alphabet (anything else gets no thumbnail). */
const YT_ID_RE = /^[A-Za-z0-9_-]{11}$/;

function lockIcon(): SVGSVGElement {
  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("viewBox", "0 0 16 16");
  svg.setAttribute("class", "room-lock");
  svg.setAttribute("role", "img");
  svg.setAttribute("aria-label", "password protected");

  const body = document.createElementNS(SVG_NS, "rect");
  body.setAttribute("x", "3");
  body.setAttribute("y", "7");
  body.setAttribute("width", "10");
  body.setAttribute("height", "8");

  const shackle = document.createElementNS(SVG_NS, "path");
  shackle.setAttribute("d", "M5.5 7V5a2.5 2.5 0 0 1 5 0v2");
  shackle.setAttribute("fill", "none");
  shackle.setAttribute("stroke", "currentColor");
  shackle.setAttribute("stroke-width", "1.6");

  svg.append(body, shackle);
  return svg;
}

/** The playing video's thumbnail and title in a room's map cell; nothing when no jukebox is playing. */
function jukeboxCell(box: { video: string; title: string }): HTMLElement {
  const thumb = YT_ID_RE.test(box.video)
    ? h("img", { class: "room-thumb", src: `https://i.ytimg.com/vi/${box.video}/default.jpg`, alt: "", loading: "lazy" })
    : null;
  return h("span", { class: "room-jukebox", title: box.title }, thumb, h("span", { class: "room-track" }, box.title));
}

/** Parse a max-players field, clamp it to the allowed range and write it back. */
function clampMaxPlayers(input: HTMLInputElement): number {
  const parsed = Number.parseInt(input.value, 10);
  const clamped = Number.isFinite(parsed)
    ? Math.min(ROOM_MAX_PLAYERS, Math.max(ROOM_MIN_PLAYERS, parsed))
    : DEFAULT_MAX_PLAYERS;
  input.value = String(clamped);
  return clamped;
}

/** The create-room form's values until a room is created. Kept in memory, so a connection drop that closes the modal keeps them. */
const createDraft = { name: "", password: "", max: DEFAULT_MAX_PLAYERS, isPublic: true };

export const browserScreen: ScreenFactory = (ctx) => {
  const { store } = ctx;

  let rooms: RoomInfo[] = store.state.rooms;
  // The locked room whose password field is open is the store's openRoom: a refused join leaves it open.
  let hideFull = false;

  const roomList = h("ul", { class: "room-table", "aria-label": "rooms" });
  const emptyHint = h("p", { class: "empty" });
  const total = h("p", { class: "muted num room-total", role: "status" });
  /** The room list while it loads: a skeleton of rows, or the refusal that stopped it, with Try again. */
  const loadingBox = h(
    "div",
    { class: "room-loading", role: "status", "aria-label": "Loading rooms" },
    h("ul", { class: "room-skeleton", "aria-hidden": "true" }, ...Array.from({ length: 6 }, () => h("li", { class: "room-skel" }))),
    h("p", { class: "muted" }, "Loading rooms…"),
  );
  const errorText = h("p", { class: "room-error-text" });
  const errorBox = h(
    "div",
    { class: "room-error", role: "alert" },
    errorText,
    h("button", { type: "button", class: "primary", onclick: () => retryList() }, icon("refresh-cw", 18), "Try again"),
  );
  /** Each listed room's row by code, with the key it was built from: a row is rebuilt only when what it shows changes. */
  const rowCache = new Map<string, { key: string; el: HTMLLIElement }>();

  const searchInput = h("input", {
    type: "search",
    placeholder: "Room, map, mode or region",
    autocomplete: "off",
    spellcheck: "false",
    oninput: () => renderRooms(),
  });

  const codeInput = h("input", {
    type: "text",
    placeholder: "K7QF2M",
    maxlength: 6,
    autocapitalize: "characters",
    autocomplete: "off",
    spellcheck: "false",
    oninput: () => {
      codeInput.value = codeInput.value.toUpperCase().replace(/[^A-Z0-9]/g, "");
      codeJoin.disabled = !ROOM_CODE_RE.test(codeInput.value);
    },
  });
  const codeJoin = h("button", { type: "submit", class: "primary", disabled: true }, icon("door-open", 18), "Join");
  const codeForm = h(
    "form",
    {
      class: "code-join",
      onsubmit: (e: Event) => {
        e.preventDefault();
        if (!ROOM_CODE_RE.test(codeInput.value)) return;
        ctx.joinRoom(codeInput.value);
      },
    },
    field("Room code", codeInput),
    codeJoin,
  );

  const noticeSlot = h("div", { class: "browser-notice-slot" });
  const inviteSlot = h("div", { class: "invite-slot" });

  /** The create-room form in a modal: it opens with the draft (what was typed since the last room was created). */
  function openCreateRoom(): void {
    const roomName = h("input", {
      type: "text",
      maxlength: MAX_ROOM_NAME_LEN,
      placeholder: "Optional",
      autocomplete: "off",
      "aria-label": "room name",
      value: createDraft.name,
      oninput: () => {
        createDraft.name = roomName.value;
      },
    });
    const roomPassword = h("input", {
      type: "password",
      placeholder: "Optional",
      autocomplete: "new-password",
      value: createDraft.password,
      oninput: () => {
        createDraft.password = roomPassword.value;
      },
    });
    const maxInput = h("input", {
      type: "number",
      min: ROOM_MIN_PLAYERS,
      max: ROOM_MAX_PLAYERS,
      step: 1,
      value: createDraft.max,
      onchange: () => {
        createDraft.max = clampMaxPlayers(maxInput);
      },
    });
    const isPublic = h("input", {
      type: "checkbox",
      role: "switch",
      checked: createDraft.isPublic,
      onchange: () => {
        createDraft.isPublic = isPublic.checked;
      },
    });

    // Each modal gets its own id: a closing modal stays in the DOM for its exit animation, so a shared id would match it.
    const formId = uid("create-room");
    const form = h(
      "form",
      {
        id: formId,
        class: "create-form",
        onsubmit: (e: Event) => {
          e.preventDefault();
          const password = roomPassword.value;
          ctx.send({
            t: "create_room",
            name: roomName.value.trim(),
            password: password === "" ? null : password,
            max_players: clampMaxPlayers(maxInput),
            public: isPublic.checked,
          });
          Object.assign(createDraft, { name: "", password: "", max: DEFAULT_MAX_PLAYERS, isPublic: true });
          modal.close();
        },
      },
      field(
        "Room name",
        roomName,
        store.state.name.trim() ? `Leave empty for "${store.state.name.trim()}'s game".` : "Leave empty for a default name.",
      ),
      field("Password", roomPassword, "Optional. Players type it to join."),
      field("Max players", maxInput, `${ROOM_MIN_PLAYERS} to ${ROOM_MAX_PLAYERS} players`),
      h("label", { class: "check" }, isPublic, "Public"),
      h("p", { class: "field-hint" }, "Public rooms show in the list. Private rooms open only with the code."),
    );
    // The submit button sits in the modal's action row, outside the form, so it names the form.
    const submit = h("button", { type: "submit", class: "primary" }, icon("plus", 18), "Create room");
    submit.setAttribute("form", formId);
    const modal = openModal({
      title: "Create a room",
      body: [form],
      actions: [h("button", { type: "button", onclick: () => modal.close() }, icon("x", 18), "Cancel"), submit],
    });
  }

  /** Password prompt for a room the server refused without one (invite link or a join that failed). */
  function inviteForm(code: string): HTMLFormElement {
    const input = h("input", {
      type: "password",
      placeholder: "Password",
      autocomplete: "off",
      "aria-label": `password for room ${code}`,
      oninput: () => {
        join.disabled = input.value === "";
      },
    });
    const join = h("button", { type: "submit", class: "primary", disabled: true }, icon("door-open", 18), "Join");
    return h(
      "form",
      {
        class: "panel invite-form",
        onsubmit: (e: Event) => {
          e.preventDefault();
          if (input.value === "") return;
          ctx.joinRoom(code, input.value);
        },
      },
      h("h2", null, icon("key-round", 20), `Room ${code} needs a password`),
      h("p", { class: "muted" }, "Enter the room's password to join."),
      h("div", { class: "room-password" }, input, join),
      h(
        "div",
        { class: "actions" },
        h("button", { type: "button", onclick: () => store.set({ invite: null }) }, icon("x", 18), "Cancel"),
      ),
    );
  }

  function renderNotice(text: string | null): void {
    if (text === null) {
      noticeSlot.replaceChildren();
      return;
    }
    noticeSlot.replaceChildren(
      h(
        "section",
        { class: "panel browser-notice", role: "alert" },
        h("p", null, text),
        h("button", { type: "button", onclick: () => store.set({ notice: null }) }, icon("x", 18), "Dismiss"),
      ),
    );
  }

  function renderInvite(code: string | null): void {
    clear(inviteSlot);
    if (code !== null) inviteSlot.appendChild(inviteForm(code));
  }

  function joinForm(room: RoomInfo): HTMLFormElement {
    const input = h("input", {
      type: "password",
      class: "join-password",
      "data-focus-key": "password",
      placeholder: "Password",
      autocomplete: "off",
      "aria-label": `password for ${room.name}`,
      oninput: () => {
        join.disabled = input.value === "";
      },
    });
    const join = h("button", { type: "submit", class: "primary", "data-focus-key": "join", disabled: true }, icon("door-open", 18), "Join");
    return h(
      "form",
      {
        class: "room-password",
        onsubmit: (e: Event) => {
          e.preventDefault();
          if (input.value === "") return;
          ctx.joinRoom(room.code, input.value);
        },
      },
      input,
      join,
    );
  }

  function onRoomClick(room: RoomInfo): void {
    if (room.password) {
      store.set({ openRoom: store.state.openRoom === room.code ? null : room.code });
      if (store.state.openRoom !== null) roomList.querySelector<HTMLInputElement>(".join-password")?.focus();
      return;
    }
    store.set({ openRoom: null });
    ctx.joinRoom(room.code);
  }

  /** Try the list again: the connection is opened once more with the saved name. */
  function retryList(): void {
    store.set({ pending: { kind: "list", error: null } });
    ctx.play(store.state.name);
  }

  /** Flag image of the host's country; the name is the alt text and tooltip. */
  function flagImg(country: string): HTMLImageElement {
    const name = countryName(country);
    return h("img", { class: "room-flag", src: flagUrl(country), alt: name, title: name, loading: "lazy" });
  }

  function roomItem(room: RoomInfo): HTMLLIElement {
    const open = room.password && store.state.openRoom === room.code;
    const row = h(
      "button",
      {
        type: "button",
        class: "room-row",
        "data-focus-key": "row",
        "aria-expanded": room.password ? String(open) : null,
        onclick: () => onRoomClick(room),
      },
      h(
        "span",
        { class: "room-name" },
        icon("door-open", 18),
        room.name,
        room.password ? lockIcon() : null,
        room.quick !== null ? h("span", { class: "chip" }, "Quick") : null,
      ),
      h("span", { class: "room-mode" }, GAME_MODES.find((m) => m.id === room.mode)?.name ?? "Unknown"),
      h(
        "span",
        { class: "room-map" },
        h("span", { class: "room-map-title" }, room.map),
        room.jukebox ? jukeboxCell(room.jukebox) : null,
      ),
      h(
        "span",
        { class: "room-where" },
        room.country !== null ? flagImg(room.country) : null,
        room.region !== "" ? h("span", { class: "room-region" }, room.region) : null,
        h("span", { class: "room-distance" }, formatDistance(room.distance, store.state.country)),
      ),
      h(
        "span",
        { class: "room-count" },
        h("span", { class: "room-players" }, icon("users", 14), `${room.players}/${room.max_players}`),
        room.in_match ? h("span", { class: "chip ink" }, "In match") : null,
      ),
    );
    // Thumbnails load small; hovering or focusing the row swaps in the larger one.
    const sharpen = (): void => {
      for (const img of row.querySelectorAll<HTMLImageElement>(".room-thumb")) {
        img.src = img.src.replace("/default.jpg", "/hqdefault.jpg");
      }
    };
    row.addEventListener("pointerenter", sharpen, { once: true });
    row.addEventListener("focus", sharpen, { once: true });
    const friends =
      room.friends.length > 0 ? h("p", { class: "room-friends" }, `Friends: ${room.friends.join(", ")}`) : null;
    return h("li", { class: "room-item", "data-code": room.code }, row, friends, open ? joinForm(room) : null);
  }

  /** The rooms that pass the filters, nearest first with friends on top. Unchanged rows are kept as they are. */
  function renderRooms(): void {
    const query = searchInput.value.trim().toLowerCase();
    const shown = sortRooms(rooms).filter((room) => {
      if (hideFull && room.players >= room.max_players) return false;
      if (query === "") return true;
      return [room.name, room.map, GAME_MODES.find((m) => m.id === room.mode)?.name ?? "Unknown", room.region].some((s) => s.toLowerCase().includes(query));
    });
    const active = document.activeElement;
    const owner = active instanceof HTMLElement ? active.closest<HTMLElement>(".room-item") : null;
    const focusKey = active instanceof HTMLElement ? active.dataset.focusKey : undefined;
    const items: HTMLLIElement[] = [];
    for (const room of shown) {
      const key = JSON.stringify([room, store.state.openRoom === room.code, store.state.country]);
      const cached = rowCache.get(room.code);
      if (cached !== undefined && cached.key === key) {
        items.push(cached.el);
        continue;
      }
      const el = roomItem(room);
      if (cached !== undefined) {
        // a rebuilt row keeps the password the viewer has typed so far
        const typed = cached.el.querySelector<HTMLInputElement>(".join-password")?.value ?? "";
        const input = el.querySelector<HTMLInputElement>(".join-password");
        if (input !== null && typed !== "") {
          input.value = typed;
          input.dispatchEvent(new Event("input"));
        }
      }
      rowCache.set(room.code, { key, el });
      items.push(el);
    }
    const listed = new Set<Element>(items);
    for (const child of Array.from(roomList.children)) if (!listed.has(child)) child.remove();
    // a row is moved only when the order changed: moving a focused row drops its focus
    items.forEach((el, i) => {
      if (roomList.children.item(i) !== el) roomList.insertBefore(el, roomList.children.item(i));
    });
    const codes = new Set(shown.map((room) => room.code));
    for (const code of rowCache.keys()) if (!codes.has(code)) rowCache.delete(code);
    // focus that a rebuild or move dropped goes back to the same control of the same room
    if (owner !== null && focusKey !== undefined && document.activeElement !== active) {
      const next = rowCache.get(owner.dataset.code ?? "")?.el;
      next?.querySelector<HTMLElement>(`[data-focus-key="${focusKey}"]`)?.focus({ preventScroll: true });
    }
    const busy = store.state.pending?.kind === "list";
    // Refresh and New room need the server: while the list loads (or has failed) they wait for it.
    refreshBtn.disabled = busy;
    newRoomBtn.disabled = busy;
    total.textContent = busy ? "" : shown.length === rooms.length ? `${rooms.length} open` : `${shown.length} of ${rooms.length} open`;
    const hint =
      rooms.length === 0
        ? "No open rooms right now. Create one and invite friends."
        : "No rooms match. Clear the search or show full rooms.";
    emptyHint.replaceChildren(icon(rooms.length === 0 ? "door-open" : "search", 40), hint);
    emptyHint.hidden = busy || shown.length > 0;
    roomList.hidden = busy;
    const failure = store.state.pending?.kind === "list" ? store.state.pending.error : null;
    loadingBox.hidden = !busy || failure !== null;
    errorBox.hidden = failure === null;
    errorText.textContent = failure ?? "";
  }

  const refreshBtn = h("button", { type: "button", onclick: () => ctx.send({ t: "list_rooms" }) }, icon("refresh-cw", 18), "Refresh");
  const newRoomBtn = h("button", { type: "button", class: "primary", onclick: () => openCreateRoom() }, icon("plus", 18), "New room");
  const head = pageHead({
    title: "Browse rooms",
    back: () => ctx.disconnect(),
    actions: [refreshBtn, newRoomBtn],
  });

  const roomsSection = h(
    "section",
    { class: "room-browser" },
    h(
      "div",
      { class: "room-tools" },
      field("Search rooms", searchInput),
      toggle("Hide full rooms", false, (on) => {
        hideFull = on;
        renderRooms();
      }),
      total,
    ),
    h(
      "div",
      { class: "room-head", "aria-hidden": "true" },
      h("span", null, "Room"),
      h("span", null, "Mode"),
      h("span", null, "Map"),
      h("span", null, "Where"),
      h("span", null, "Players"),
    ),
    roomList,
    emptyHint,
    loadingBox,
    errorBox,
  );

  const el = page("browser", head, noticeSlot, codeForm, inviteSlot, roomsSection);

  renderNotice(store.state.notice);
  renderRooms();
  renderInvite(store.state.invite);

  return {
    el,
    update(state, prev) {
      if (state.rooms !== prev.rooms || state.country !== prev.country || state.pending !== prev.pending || state.openRoom !== prev.openRoom) {
        rooms = state.rooms;
        renderRooms();
      }
      if (state.notice !== prev.notice) renderNotice(state.notice);
      if (state.invite !== prev.invite) renderInvite(state.invite);
    },
    destroy() {
      el.remove();
    },
  };
};
