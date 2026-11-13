// Room browser: server name header, room list (click to join; locked rooms
// reveal an inline password field), and the create-room form.

import type { ScreenFactory } from "../../ctx";
import {
  MAX_ROOM_NAME_LEN,
  ROOM_MAX_PLAYERS,
  ROOM_MIN_PLAYERS,
  type RoomInfo,
} from "../../protocol";
import { clear, h } from "../dom";

const SVG_NS = "http://www.w3.org/2000/svg";
const DEFAULT_MAX_PLAYERS = 8;

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

export const browserScreen: ScreenFactory = (ctx) => {
  const { store } = ctx;

  let rooms: RoomInfo[] = store.state.rooms;
  /** Code of the locked room whose password field is open. */
  let pendingCode: string | null = null;

  const title = h("h1", { class: "server-name" }, store.state.serverName || "Rooms");

  const roomList = h("ul", { class: "room-list", "aria-label": "rooms" });
  const emptyHint = h("p", { class: "empty-hint" }, "No rooms yet. Create one below, or press Refresh.");

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
    ctx.send({ t: "join_room", room: room.code, password: null });
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
      h("span", { class: "room-name" }, room.name),
      h("span", { class: "room-map" }, room.map),
      h("span", { class: "room-count" }, `${room.players}/${room.max_players}`),
      room.password ? lockIcon() : null,
      room.in_match ? h("span", { class: "badge" }, "in match") : null,
    );
    return h("li", { class: "room-item" }, row, open ? joinForm(room) : null);
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
    h("section", { class: "panel room-browser" }, h("h2", null, "Rooms"), roomList, emptyHint),
    createForm,
  );

  renderRooms();

  return {
    el,
    update(state, prev) {
      if (state.serverName !== prev.serverName) title.textContent = state.serverName || "Rooms";
      if (state.rooms !== prev.rooms) {
        rooms = state.rooms;
        renderRooms();
      }
    },
    destroy() {
      el.remove();
    },
  };
};
