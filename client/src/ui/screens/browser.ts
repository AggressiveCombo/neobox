// The Play screen: quick play and join-by-code at the top; the open rooms as a table (search,
// hide full rooms; nearest first, friends on top); the create-room form beside it on desktop and
// below it on phones. Locked rooms ask for their password inline; a server that refused a join
// asks for it in a panel above the list.

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
import { field, page, pageHead, toggle } from "../kit";

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

export const browserScreen: ScreenFactory = (ctx) => {
  const { store } = ctx;

  let rooms: RoomInfo[] = store.state.rooms;
  /** Code of the locked room whose password field is open. */
  let pendingCode: string | null = null;
  let hideFull = false;

  const roomList = h("ul", { class: "room-table", "aria-label": "rooms" });
  const emptyHint = h("p", { class: "empty" });
  const total = h("p", { class: "muted num room-total", role: "status" });

  const searchInput = h("input", {
    type: "search",
    placeholder: "Room, map, mode or region",
    autocomplete: "off",
    spellcheck: "false",
    oninput: () => renderRooms(),
  });

  const codeInput = h("input", {
    type: "text",
    placeholder: "Room code",
    maxlength: 6,
    autocapitalize: "characters",
    autocomplete: "off",
    spellcheck: "false",
    oninput: () => {
      codeInput.value = codeInput.value.toUpperCase().replace(/[^A-Z0-9]/g, "");
      codeJoin.disabled = !ROOM_CODE_RE.test(codeInput.value);
    },
  });
  const codeJoin = h("button", { type: "submit", class: "primary", disabled: true }, "Join");
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
    field("Join with a code", codeInput),
    codeJoin,
  );

  const quickPlay = h(
    "section",
    { class: "panel start-quick" },
    h("p", { class: "lead" }, "Jump into an open room, or start a new one, in one tap."),
    h(
      "button",
      { type: "button", class: "primary big", onclick: () => store.set({ screen: "quick" }) },
      "Quick play",
    ),
  );
  const startCode = h(
    "section",
    { class: "panel start-code" },
    h("p", { class: "lead" }, "Have a room code from a friend?"),
    codeForm,
  );

  const inviteSlot = h("div", { class: "invite-slot" });

  const roomName = h("input", {
    type: "text",
    maxlength: MAX_ROOM_NAME_LEN,
    placeholder: "Optional",
    autocomplete: "off",
    "aria-label": "room name",
  });
  const roomPassword = h("input", {
    type: "password",
    placeholder: "Optional",
    autocomplete: "new-password",
  });
  const maxInput = h("input", {
    type: "number",
    min: ROOM_MIN_PLAYERS,
    max: ROOM_MAX_PLAYERS,
    step: 1,
    value: DEFAULT_MAX_PLAYERS,
    onchange: () => {
      readMaxPlayers();
    },
  });
  const isPublic = h("input", { type: "checkbox", role: "switch", checked: true });

  /** Parse the max-players field, clamp it to the allowed range and write it back. */
  function readMaxPlayers(): number {
    const parsed = Number.parseInt(maxInput.value, 10);
    const clamped = Number.isFinite(parsed)
      ? Math.min(ROOM_MAX_PLAYERS, Math.max(ROOM_MIN_PLAYERS, parsed))
      : DEFAULT_MAX_PLAYERS;
    maxInput.value = String(clamped);
    return clamped;
  }

  function createRoom(): void {
    const password = roomPassword.value;
    ctx.send({
      t: "create_room",
      name: roomName.value.trim(),
      password: password === "" ? null : password,
      max_players: readMaxPlayers(),
      public: isPublic.checked,
    });
  }

  const createForm = h(
    "form",
    {
      class: "panel create-form",
      onsubmit: (e: Event) => {
        e.preventDefault();
        createRoom();
      },
    },
    h("h2", null, "Create a room"),
    field("Room name", roomName),
    field("Password", roomPassword, "Optional. Players type it to join."),
    field("Max players", maxInput, `${ROOM_MIN_PLAYERS} to ${ROOM_MAX_PLAYERS} players`),
    h("label", { class: "check" }, isPublic, "Public"),
    h("p", { class: "field-hint" }, "Public rooms show in the list. Private rooms open only with the code."),
    h("div", { class: "actions" }, h("button", { type: "submit", class: "primary" }, "Create room")),
  );

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
    const join = h("button", { type: "submit", class: "primary", disabled: true }, "Join");
    return h(
      "form",
      {
        class: "panel invite-form",
        onsubmit: (e: Event) => {
          e.preventDefault();
          if (input.value === "") return;
          ctx.send({ t: "join_room", room: code, password: input.value });
        },
      },
      h("h2", null, `Room ${code} needs a password`),
      h("p", { class: "muted" }, "Enter the room's password to join."),
      h("div", { class: "room-password" }, input, join),
      h(
        "div",
        { class: "actions" },
        h("button", { type: "button", onclick: () => store.set({ invite: null }) }, "Cancel"),
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
      placeholder: "Password",
      autocomplete: "off",
      "aria-label": `password for ${room.name}`,
      oninput: () => {
        join.disabled = input.value === "";
      },
    });
    const join = h("button", { type: "submit", class: "primary", disabled: true }, "Join");
    return h(
      "form",
      {
        class: "room-password",
        onsubmit: (e: Event) => {
          e.preventDefault();
          if (input.value === "") return;
          ctx.send({ t: "join_room", room: room.code, password: input.value });
        },
      },
      input,
      join,
    );
  }

  function onRoomClick(room: RoomInfo): void {
    if (room.password) {
      pendingCode = pendingCode === room.code ? null : room.code;
      renderRooms();
      if (pendingCode !== null) roomList.querySelector<HTMLInputElement>(".join-password")?.focus();
      return;
    }
    pendingCode = null;
    ctx.joinRoom(room.code);
  }

  /** Flag image of the host's country; the name is the alt text and tooltip. */
  function flagImg(country: string): HTMLImageElement {
    const name = countryName(country);
    return h("img", { class: "room-flag", src: flagUrl(country), alt: name, title: name, loading: "lazy" });
  }

  function roomItem(room: RoomInfo): HTMLLIElement {
    const open = room.password && pendingCode === room.code;
    const row = h(
      "button",
      {
        type: "button",
        class: "room-row",
        "aria-expanded": room.password ? String(open) : null,
        onclick: () => onRoomClick(room),
      },
      h(
        "span",
        { class: "room-name" },
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
        h("span", { class: "room-players" }, `${room.players}/${room.max_players}`),
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
    return h("li", { class: "room-item" }, row, friends, open ? joinForm(room) : null);
  }

  /** The rooms that pass the filters, nearest first with friends on top. */
  function renderRooms(): void {
    const query = searchInput.value.trim().toLowerCase();
    const shown = sortRooms(rooms).filter((room) => {
      if (hideFull && room.players >= room.max_players) return false;
      if (query === "") return true;
      return [room.name, room.map, GAME_MODES.find((m) => m.id === room.mode)?.name ?? "Unknown", room.region].some((s) => s.toLowerCase().includes(query));
    });
    clear(roomList);
    for (const room of shown) roomList.appendChild(roomItem(room));
    total.textContent = shown.length === rooms.length ? `${rooms.length} open` : `${shown.length} of ${rooms.length} open`;
    emptyHint.textContent =
      rooms.length === 0
        ? "No open rooms right now. Create one and invite friends."
        : "No rooms match. Clear the search or show full rooms.";
    emptyHint.hidden = shown.length > 0;
  }

  const head = pageHead({
    title: "Play",
    back: () => ctx.disconnect(),
    actions: [h("button", { type: "button", onclick: () => ctx.send({ t: "list_rooms" }) }, "Refresh")],
  });

  const roomsPanel = h(
    "section",
    { class: "panel room-browser" },
    h("div", { class: "room-browser-head" }, h("h2", null, "Open rooms"), total),
    h(
      "div",
      { class: "room-tools" },
      field("Search rooms", searchInput),
      toggle("Hide full rooms", false, (on) => {
        hideFull = on;
        renderRooms();
      }),
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
  );

  const el = page(
    "browser",
    head,
    h("div", { class: "browser-start" }, quickPlay, startCode),
    inviteSlot,
    h("div", { class: "browser-main" }, roomsPanel, createForm),
  );

  renderRooms();
  renderInvite(store.state.invite);

  return {
    el,
    update(state, prev) {
      if (state.rooms !== prev.rooms || state.country !== prev.country) {
        rooms = state.rooms;
        renderRooms();
      }
      if (state.invite !== prev.invite) renderInvite(state.invite);
    },
    destroy() {
      el.remove();
    },
  };
};
