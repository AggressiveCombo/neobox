// Room lobby: header, notice, players and team actions, mode, map, settings and chat.
// Room-derived sections rebuild only when the inputs they read change, so settings
// inputs and draft text survive unrelated room updates.

import { h } from "../dom";
import type { AppCtx, ScreenFactory } from "../../ctx";
import type { BuiltinMap } from "../../api";
import type { AppState, ChatLine } from "../../state";
import {
  GAME_MODES,
  MAX_CHAT_LEN,
  TEAM_BLUE,
  TEAM_FFA,
  TEAM_RED,
  TEAM_SPECTATOR,
  isTeamMode,
} from "../../protocol";
import type { PlayerInfo, RoomState } from "../../protocol";
import { SETTINGS, formatValue, normalizeInput, readOnlyKeys } from "../../settings";
import type { SettingDef } from "../../settings";
import { drawMapPreview } from "../../render/preview";

interface TeamAction {
  label: string;
  team: number;
}

const TEAM_ACTIONS_TEAMS: readonly TeamAction[] = [
  { label: "Red", team: TEAM_RED },
  { label: "Blue", team: TEAM_BLUE },
  { label: "Spectate", team: TEAM_SPECTATOR },
];

const TEAM_ACTIONS_FFA: readonly TeamAction[] = [
  { label: "Join", team: TEAM_FFA },
  { label: "Spectate", team: TEAM_SPECTATOR },
];

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function roomMode(room: RoomState): number | null {
  const v = room.settings["game_mode"];
  return typeof v === "number" ? v : null;
}

function modeName(mode: number | null): string {
  return GAME_MODES.find((m) => m.id === mode)?.name ?? "mode";
}

/** Column a player is listed under: team modes use red/blue/spectators, others players/spectators. */
function columnOf(p: PlayerInfo, teams: boolean): number {
  if (p.team === TEAM_SPECTATOR) return TEAM_SPECTATOR;
  if (!teams) return TEAM_FFA;
  return p.team === TEAM_RED || p.team === TEAM_BLUE ? p.team : TEAM_SPECTATOR;
}

function show(v: unknown): string {
  return v === undefined ? "" : formatValue(v);
}

function fact(label: string, value: string): HTMLElement {
  return h("div", { class: "room-fact" }, h("dt", null, label), h("dd", null, value));
}

function chatLine(line: ChatLine, myId: number | null): HTMLElement {
  if (line.from === null) return h("div", { class: "room-chat-line room-chat-system" }, line.text);
  const mine = line.from === myId ? "room-chat-line is-me" : "room-chat-line";
  return h("div", { class: mine }, h("span", { class: "room-chat-name" }, line.name), ": ", line.text);
}

/** Rebuilds `slot` only when `key` differs from the previous call. */
function keyed(slot: HTMLElement, build: () => Node[]): (key: string) => void {
  let last: string | null = null;
  return (key) => {
    if (key === last) return;
    last = key;
    slot.replaceChildren(...build());
  };
}

export const roomScreen: ScreenFactory = (ctx: AppCtx) => {
  let st: AppState = ctx.store.state;
  let alive = true;
  let builtins: BuiltinMap[] | null = null;
  let mapsError: string | null = null;
  let lastMapName: string | null = null;
  let drawnCode: string | null = null;

  const isHost = (): boolean => st.room !== null && st.room.players.some((p) => p.id === st.myId && p.host);

  // Actions. Host-only messages are guarded here as well as disabled in the DOM.
  const leave = (): void => ctx.send({ t: "leave_room" });
  const kick = (player: number, ban: boolean): void => {
    if (isHost()) ctx.send({ t: "kick", player, ban });
  };
  const start = (): void => {
    if (isHost()) ctx.send({ t: "start" });
  };
  const setMode = (mode: number): void => {
    if (isHost()) ctx.send({ t: "set_mode", mode });
  };
  const resetSettings = (): void => {
    if (isHost()) ctx.send({ t: "reset_settings" });
  };
  const setSetting = (def: SettingDef, raw: string): void => {
    if (isHost()) ctx.send({ t: "set_setting", key: def.label, value: normalizeInput(def.kind, raw) });
  };
  const sendChat = (): void => {
    const text = chatInput.value.trim();
    if (text === "") return;
    ctx.send({ t: "chat", text });
    chatInput.value = "";
  };

  // Map handling.
  /** Draws the preview of `code`; false (and a toast) when the engine rejects it. */
  function showPreview(code: string): boolean {
    if (code === drawnCode) return true;
    try {
      drawMapPreview(mapCanvas, ctx.wasm.mapPreview(code));
      drawnCode = code;
      return true;
    } catch (err: unknown) {
      ctx.toast(errorMessage(err), "error");
      return false;
    }
  }

  function chooseMap(code: string, name: string | null): boolean {
    if (!isHost() || !showPreview(code)) return false;
    ctx.send({ t: "set_map", code, name });
    return true;
  }

  /** Accepts a map code, or map JSON (starts with "{") that is compacted into a code first. */
  function submitMapText(raw: string): boolean {
    const text = raw.trim();
    if (text === "") {
      ctx.toast("paste a map code or map JSON first", "error");
      return false;
    }
    if (!text.startsWith("{")) return chooseMap(text, null);
    let code: string;
    try {
      code = ctx.wasm.mapEncode(text);
    } catch (err: unknown) {
      ctx.toast(errorMessage(err), "error");
      return false;
    }
    return chooseMap(code, null);
  }

  async function loadMapFile(): Promise<void> {
    const file = fileInput.files?.[0];
    fileInput.value = "";
    if (!file) return;
    let text: string;
    try {
      text = await file.text();
    } catch (err: unknown) {
      ctx.toast(errorMessage(err), "error");
      return;
    }
    submitMapText(text);
  }

  /** Previews the built-in map matching the room's current map name (visible to everyone). */
  function previewRoomMap(): void {
    const map = builtins?.find((m) => m.name === lastMapName);
    if (map) showPreview(map.code);
  }

  function buildMapList(): Node[] {
    if (!isHost()) return [];
    if (mapsError !== null) return [h("p", { class: "room-status is-error" }, `could not load maps: ${mapsError}`)];
    if (builtins === null) return [h("p", { class: "room-muted" }, "loading maps")];
    if (builtins.length === 0) return [h("p", { class: "room-muted" }, "no built-in maps")];
    return builtins.map((map) => {
      const current = map.name === lastMapName;
      return h(
        "button",
        {
          type: "button",
          class: current ? "room-btn is-current" : "room-btn",
          "aria-pressed": current ? "true" : "false",
          onclick: () => {
            chooseMap(map.code, map.name);
          },
        },
        map.name,
      );
    });
  }

  // Static DOM. Sections are built once; their contents are rebuilt by the keyed renderers.
  const header = h("header", { class: "room-header" });
  const notice = h("p", { class: "room-notice", role: "status" });

  const playersBody = h("div", { class: "room-players-body" });
  const renderPlayers = keyed(playersBody, buildPlayers);
  const playersPanel = h("section", { class: "room-panel room-players" }, h("h2", { class: "room-panel-title" }, "Players"), playersBody);

  const modeBody = h("div", { class: "room-mode-body" });
  const renderMode = keyed(modeBody, buildMode);
  const modePanel = h("section", { class: "room-panel room-mode" }, h("h2", { class: "room-panel-title" }, "Mode"), modeBody);

  const mapName = h("p", { class: "room-map-name" });
  const mapCanvas = h("canvas", {
    class: "room-map-preview",
    width: 480,
    height: 240,
    role: "img",
    "aria-label": "Map preview",
  });
  const mapList = h("div", { class: "room-map-list" });
  const textarea = h("textarea", {
    class: "room-map-code",
    rows: 3,
    placeholder: "paste a map code or map JSON",
    "aria-label": "Map code or JSON",
  });
  const fileInput = h("input", {
    type: "file",
    accept: ".txt,.json,.neobox",
    onchange: () => {
      void loadMapFile();
    },
  });
  const mapControls = h(
    "div",
    { class: "room-map-controls" },
    h("h3", { class: "room-subtitle" }, "Built-in maps"),
    mapList,
    h("h3", { class: "room-subtitle" }, "Custom map"),
    textarea,
    h(
      "div",
      { class: "room-actions" },
      h(
        "button",
        {
          type: "button",
          class: "room-btn",
          onclick: () => {
            if (submitMapText(textarea.value)) textarea.value = "";
          },
        },
        "Use code",
      ),
      h("label", { class: "room-file" }, "Load file", fileInput),
    ),
  );
  const mapPanel = h("section", { class: "room-panel room-map" }, h("h2", { class: "room-panel-title" }, "Map"), mapName, mapCanvas, mapControls);

  const settingsBody = h("div", { class: "room-settings-body" });
  const renderSettings = keyed(settingsBody, buildSettings);
  const settingsPanel = h("section", { class: "room-panel room-settings-panel" }, h("h2", { class: "room-panel-title" }, "Settings"), settingsBody);

  const chatLog = h("div", { class: "room-chat-log", role: "log", "aria-live": "polite" });
  const chatInput = h("input", {
    type: "text",
    class: "room-chat-input",
    maxlength: MAX_CHAT_LEN,
    placeholder: "message",
    "aria-label": "Chat message",
    onkeydown: (e) => {
      if (e instanceof KeyboardEvent && e.key === "Enter" && !e.isComposing) sendChat();
    },
  });
  const chatPanel = h(
    "section",
    { class: "room-panel room-chat" },
    h("h2", { class: "room-panel-title" }, "Chat"),
    chatLog,
    h(
      "div",
      { class: "room-chat-form" },
      chatInput,
      h("button", { type: "button", class: "room-btn", onclick: sendChat }, "Send"),
    ),
  );

  const main = h(
    "div",
    { class: "room-main" },
    h("div", { class: "room-col" }, playersPanel, modePanel, mapPanel),
    h("div", { class: "room-col" }, chatPanel, settingsPanel),
  );
  const root = h("div", { class: "room-screen" }, header, notice, main);

  // Section builders. Each reads `st`, which is set before any render runs.

  function buildHeader(room: RoomState): Node[] {
    return [
      h(
        "div",
        { class: "room-heading" },
        h("h1", { class: "room-title" }, room.name),
        h("button", { type: "button", class: "room-btn", onclick: leave }, "Leave"),
      ),
      h(
        "dl",
        { class: "room-facts" },
        fact("Code", room.code),
        fact("Map", room.map_name),
        fact("Mode", modeName(roomMode(room))),
        fact("Players", `${room.players.length} / ${room.max_players}`),
      ),
    ];
  }

  function playerRow(p: PlayerInfo, host: boolean): HTMLElement {
    const isMe = p.id === st.myId;
    const ping = p.ping_ms >= 0 ? `${p.ping_ms} ms` : "-";
    return h(
      "li",
      { class: isMe ? "room-player is-me" : "room-player" },
      h("span", { class: "room-player-name" }, p.name),
      isMe ? h("span", { class: "room-you" }, "you") : null,
      p.host ? h("span", { class: "room-host", title: "room host" }, "host") : null,
      h("span", { class: "room-ping" }, ping),
      host && !isMe
        ? h(
            "span",
            { class: "room-player-actions" },
            h("button", { type: "button", class: "room-btn room-btn-small", onclick: () => kick(p.id, false) }, "Kick"),
            h("button", { type: "button", class: "room-btn room-btn-small room-btn-danger", onclick: () => kick(p.id, true) }, "Ban"),
          )
        : null,
    );
  }

  function buildPlayers(): Node[] {
    const room = st.room;
    if (room === null) return [];
    const mode = roomMode(room);
    const teams = mode !== null && isTeamMode(mode);
    const host = isHost();
    const columns: { title: string; bucket: number }[] = teams
      ? [
          { title: "Red", bucket: TEAM_RED },
          { title: "Blue", bucket: TEAM_BLUE },
          { title: "Spectators", bucket: TEAM_SPECTATOR },
        ]
      : [
          { title: "Players", bucket: TEAM_FFA },
          { title: "Spectators", bucket: TEAM_SPECTATOR },
        ];
    const me = room.players.find((p) => p.id === st.myId);
    const actions = teams ? TEAM_ACTIONS_TEAMS : TEAM_ACTIONS_FFA;
    return [
      h(
        "div",
        { class: "room-columns" },
        columns.map((col) => {
          const members = room.players.filter((p) => columnOf(p, teams) === col.bucket);
          return h(
            "div",
            { class: "room-column" },
            h("h3", { class: "room-column-title" }, `${col.title} (${members.length})`),
            members.length === 0
              ? h("p", { class: "room-muted" }, "none")
              : h("ul", { class: "room-list" }, members.map((p) => playerRow(p, host))),
          );
        }),
      ),
      h(
        "div",
        { class: "room-actions" },
        h("span", { class: "room-label" }, "Your team"),
        actions.map((a) => {
          const current = me?.team === a.team;
          return h(
            "button",
            {
              type: "button",
              class: current ? "room-btn is-current" : "room-btn",
              "aria-pressed": current ? "true" : "false",
              onclick: () => ctx.send({ t: "set_team", team: a.team }),
            },
            a.label,
          );
        }),
      ),
      ...(host
        ? [
            h(
              "div",
              { class: "room-actions" },
              h(
                "button",
                { type: "button", class: "room-btn room-btn-primary", disabled: room.in_match, onclick: start },
                "Start",
              ),
            ),
          ]
        : []),
    ];
  }

  function buildMode(): Node[] {
    const room = st.room;
    if (room === null) return [];
    const mode = roomMode(room);
    if (!isHost()) return [h("p", { class: "room-mode-name" }, modeName(mode))];
    const select = h(
      "select",
      {
        class: "room-mode-select",
        "aria-label": "Game mode",
        onchange: () => {
          if (select.value !== "") setMode(Number(select.value));
        },
      },
      mode === null ? h("option", { value: "", disabled: true, selected: true }, "mode") : null,
      GAME_MODES.map((m) => h("option", { value: String(m.id), selected: m.id === mode }, m.name)),
    );
    return [select];
  }

  function settingRow(def: SettingDef, value: unknown, host: boolean): HTMLElement {
    if (def.kind === "b") {
      const box = h("input", {
        type: "checkbox",
        checked: value === true,
        disabled: !host,
        onchange: () => setSetting(def, String(box.checked)),
      });
      return h("label", { class: "room-setting" }, h("span", { class: "room-setting-label" }, def.label), box);
    }
    const num = h("input", {
      type: "number",
      step: def.kind === "f" ? "any" : "1",
      value: show(value),
      disabled: !host,
      onchange: () => {
        if (num.value === "") num.value = show(value);
        else setSetting(def, num.value);
      },
    });
    return h("label", { class: "room-setting" }, h("span", { class: "room-setting-label" }, def.label), num);
  }

  function buildSettings(): Node[] {
    const room = st.room;
    if (room === null) return [];
    const host = isHost();
    const groups = new Map<string, SettingDef[]>();
    for (const def of SETTINGS) {
      const defs = groups.get(def.group);
      if (defs) defs.push(def);
      else groups.set(def.group, [def]);
    }
    const nodes: Node[] = [];
    for (const [group, defs] of groups) {
      nodes.push(
        h(
          "fieldset",
          { class: "room-settings-group" },
          h("legend", null, group),
          defs.map((def) => settingRow(def, room.settings[def.field], host)),
        ),
      );
    }
    const extra = readOnlyKeys(room.settings);
    if (extra.length > 0) {
      nodes.push(
        h(
          "fieldset",
          { class: "room-settings-group" },
          h("legend", null, "Read-only"),
          extra.map((key) =>
            h(
              "div",
              { class: "room-setting" },
              h("span", { class: "room-setting-label" }, key),
              h("span", { class: "room-setting-value" }, show(room.settings[key])),
            ),
          ),
        ),
      );
    }
    if (host) {
      nodes.push(
        h(
          "div",
          { class: "room-actions" },
          h("button", { type: "button", class: "room-btn", onclick: resetSettings }, "Reset settings"),
        ),
      );
    }
    return nodes;
  }

  function renderRoom(): void {
    const room = st.room;
    const inNotice = room !== null && room.in_match && !st.inMatch;
    header.hidden = room === null;
    main.hidden = room === null;
    notice.hidden = !inNotice;
    notice.textContent = inNotice ? "match in progress" : "";
    if (room === null) return;

    const host = isHost();
    const mode = roomMode(room);
    lastMapName = room.map_name;
    previewRoomMap();
    header.replaceChildren(...buildHeader(room));
    renderPlayers(JSON.stringify([room.players, st.myId, mode, host, room.in_match]));
    renderMode(`${host}|${mode}`);
    mapName.textContent = room.map_name;
    mapControls.hidden = !host;
    // Map buttons carry no input state, so rebuilding them on every room render is safe.
    mapList.replaceChildren(...buildMapList());
    renderSettings(`${host}|${JSON.stringify(room.settings)}`);
  }

  function renderChat(): void {
    chatLog.replaceChildren(...st.chat.map((line) => chatLine(line, st.myId)));
    chatLog.scrollTop = chatLog.scrollHeight;
  }

  renderRoom();
  renderChat();

  // Built-in maps are loaded once; they feed the list (host) and the room map preview (everyone).
  ctx.maps().then(
    (list) => {
      if (!alive) return;
      builtins = list;
      renderRoom();
    },
    (err: unknown) => {
      if (!alive) return;
      mapsError = errorMessage(err);
      renderRoom();
    },
  );

  return {
    el: root,
    update(next, prev) {
      st = next;
      if (next.room !== prev.room || next.myId !== prev.myId || next.inMatch !== prev.inMatch) renderRoom();
      if (next.chat !== prev.chat) renderChat();
    },
    destroy() {
      alive = false;
    },
  };
};
