// Room browser: server name header, quick play, join by room code, an invite
// password prompt (for links and refused joins), the room list (click to join;
// locked rooms reveal an inline password field) and the create-room form.

import type { ScreenFactory } from "../../ctx";
import {
  GAME_MODES,
  MAX_ROOM_NAME_LEN,
  ROOM_MAX_PLAYERS,
  ROOM_MIN_PLAYERS,
  type RoomInfo,
} from "../../protocol";
import { clear, h } from "../dom";

const SVG_NS = "http://www.w3.org/2000/svg";
const DEFAULT_MAX_PLAYERS = 8;
/** Room codes: 6 characters from the server's alphabet (no I, O, 0 or 1). */
const ROOM_CODE_RE = /^[A-HJ-NP-Z2-9]{6}$/;
/** YouTube video ids: 11 characters from the URL-safe alphabet (anything else gets no thumbnail). */
const YT_ID_RE = /^[A-Za-z0-9_-]{11}$/;

function lockIcon(): SVGSVGElement {
  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("viewBox", "0 0 16 16");
  svg.setAttribute("class", "lock");
  svg.setAttribute("role", "img");
  svg.setAttribute("aria-label", "password protected");

  const body = document.createElementNS(SVG_NS, "rect");
  body.setAttribute("x", "3");
  body.setAttribute("y", "7");
  body.setAttribute("width", "10");
  body.setAttribute("height", "8");
  body.setAttribute("rx", "1.5");

  const shackle = document.createElementNS(SVG_NS, "path");
  shackle.setAttribute("d", "M5.5 7V5a2.5 2.5 0 0 1 5 0v2");
  shackle.setAttribute("fill", "none");
  shackle.setAttribute("stroke", "currentColor");
  shackle.setAttribute("stroke-width", "1.6");

  svg.append(body, shackle);
  return svg;
}

function modeName(mode: number): string {
  return GAME_MODES.find((m) => m.id === mode)?.name ?? "Unknown";
}

/** The jukebox column of a room row: the playing video's thumbnail and title, empty when nothing plays. */
function jukeboxCell(box: { video: string; title: string } | null): HTMLElement {
  if (box === null) return h("span", { class: "room-jukebox" });
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

  const title = h("h1", { class: "server-name" }, store.state.serverName || "Rooms");

  const roomList = h("ul", { class: "room-list", "aria-label": "rooms" });
  const emptyHint = h("p", { class: "empty-hint" }, "No rooms yet. Create one below, or press Refresh.");

  const codeInput = h("input", {
    type: "text",
    placeholder: "room code",
    maxlength: 6,
    autocapitalize: "characters",
    autocomplete: "off",
    spellcheck: "false",
    "aria-label": "room code",
    oninput: () => {
      codeInput.value = codeInput.value.toUpperCase().replace(/[^A-Z0-9]/g, "");
      codeJoin.disabled = !ROOM_CODE_RE.test(codeInput.value);
    },
  });
  const codeJoin = h("button", { type: "submit", disabled: true }, "Join");
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
    codeInput,
    codeJoin,
  );

  const inviteSlot = h("div", { class: "invite-slot" });

  const roomName = h("input", {
    type: "text",
    maxlength: MAX_ROOM_NAME_LEN,
    placeholder: "room name (optional)",
    autocomplete: "off",
    "aria-label": "room name",
  });
  const roomPassword = h("input", {
    type: "password",
    placeholder: "password (optional)",
    autocomplete: "new-password",
    "aria-label": "room password",
  });
  const maxInput = h("input", {
    type: "number",
    min: ROOM_MIN_PLAYERS,
    max: ROOM_MAX_PLAYERS,
    step: 1,
    value: DEFAULT_MAX_PLAYERS,
    "aria-label": "max players",
    onchange: () => {
      readMaxPlayers();
    },
  });
  const isPublic = h("input", { type: "checkbox", checked: true });

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
    h("label", { class: "field" }, h("span", { class: "field-label" }, "Name"), roomName),
    h("label", { class: "field" }, h("span", { class: "field-label" }, "Password"), roomPassword),
    h("label", { class: "field" }, h("span", { class: "field-label" }, "Max players"), maxInput),
    h("label", { class: "check" }, isPublic, "Public"),
    h("div", { class: "actions" }, h("button", { type: "submit", class: "primary" }, "Create room")),
  );

  /** Password prompt for a room the server refused without one (invite link or a join that failed). */
  function inviteForm(code: string): HTMLFormElement {
    const input = h("input", {
      type: "password",
      placeholder: "password",
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
      h("label", { class: "field" }, h("span", { class: "field-label" }, "Password"), input),
      h(
        "div",
        { class: "actions" },
        join,
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
      placeholder: "password",
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
        room.quick !== null ? h("span", { class: "badge quick-badge" }, "Quick") : null,
      ),
      h("span", { class: "room-mode" }, modeName(room.mode)),
      h("span", { class: "room-map" }, room.map),
      jukeboxCell(room.jukebox),
      h("span", { class: "room-count" }, `${room.players}/${room.max_players}`),
      room.in_match ? h("span", { class: "badge" }, "in match") : null,
    );
    const friends =
      room.friends.length > 0 ? h("p", { class: "room-friends" }, `Friends: ${room.friends.join(", ")}`) : null;
    return h("li", { class: "room-item" }, row, friends, open ? joinForm(room) : null);
  }

  function renderRooms(): void {
    clear(roomList);
    emptyHint.hidden = rooms.length > 0;
    for (const room of rooms) roomList.appendChild(roomItem(room));
  }

  const el = h(
    "div",
    { class: "screen browser" },
    h(
      "header",
      { class: "browser-header" },
      title,
      h(
        "div",
        { class: "actions" },
        h("button", { type: "button", onclick: () => ctx.send({ t: "list_rooms" }) }, "Refresh"),
        h("button", { type: "button", onclick: () => ctx.disconnect() }, "Back"),
      ),
    ),
    h(
      "section",
      { class: "panel quick" },
      h(
        "div",
        { class: "quick-row" },
        h(
          "button",
          { type: "button", class: "primary", onclick: () => store.set({ screen: "quick" }) },
          "Quick play",
        ),
        codeForm,
      ),
      h("p", { class: "hint" }, "Quick play joins an open room, or makes a new one."),
    ),
    inviteSlot,
    h(
      "section",
      { class: "panel room-browser" },
      h("h2", null, "Rooms"),
      h(
        "div",
        { class: "room-head", "aria-hidden": "true" },
        h("span", null, "Room"),
        h("span", null, "Mode"),
        h("span", null, "Map"),
        h("span", null, "Playing"),
        h("span", null, "Players"),
      ),
      roomList,
      emptyHint,
    ),
    createForm,
  );

  renderRooms();
  renderInvite(store.state.invite);

  return {
    el,
    update(state, prev) {
      if (state.serverName !== prev.serverName) title.textContent = state.serverName || "Rooms";
      if (state.rooms !== prev.rooms) {
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
