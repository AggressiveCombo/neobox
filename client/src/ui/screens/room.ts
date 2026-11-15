// Room lobby: header, notice, players and team actions, mode, map, host manage, settings and chat.
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
import { cssHex } from "../../render/geometry";
import { openLibraryPicker } from "../library-picker";
import { acceptFriend, listFriends, removeFriend, requestFriend, type FriendState } from "../../account";
import { filterProfanity } from "../../profanity";
import { prefs } from "../../prefs";
import { openColorPicker } from "../color-picker";

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

/** Chat lines remembered for Up/Down recall. */
const SENT_LIMIT = 50;

/** A player's typing signal shows in the roster for this long after the last one. */
const TYPING_SHOW_MS = 3000;
/** Our own typing signals are sent at most this often. */
const TYPING_SEND_MS = 1000;
/** How often the roster checks whether a typing signal has expired. */
const TYPING_TICK_MS = 500;

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

/** How long ago a unix-seconds time was, in the largest whole unit ("3 days ago"). */
function ageText(unixSeconds: number): string {
  const s = Math.max(0, Date.now() / 1000 - unixSeconds);
  for (const [size, unit] of [
    [86_400, "day"],
    [3600, "hour"],
    [60, "minute"],
  ] as const) {
    if (s >= size) {
      const n = Math.floor(s / size);
      return `${n} ${unit}${n === 1 ? "" : "s"} ago`;
    }
  }
  return "just now";
}

function chatLine(line: ChatLine, myId: number | null, text: string, onPlay: ((video: string) => void) | null): HTMLElement {
  if (line.from === null) return h("div", { class: "room-chat-line room-chat-system" }, text);
  const mine = line.from === myId ? "room-chat-line is-me" : "room-chat-line";
  const suggest = line.suggest;
  return h(
    "div",
    { class: mine },
    h("span", { class: "room-chat-name" }, line.name),
    ": ",
    text,
    suggest
      ? h(
          "div",
          { class: "room-chat-suggest" },
          h("span", null, `suggests ${suggest.title}`),
          onPlay ? h("button", { type: "button", class: "room-btn room-btn-small", onclick: () => onPlay(suggest.video) }, "Play on jukebox") : null,
        )
      : null,
  );
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

/** Compress a replay JSON document with gzip (the .nbreplay file format). */
async function gzipText(text: string): Promise<Blob> {
  const stream = new Blob([text]).stream().pipeThrough(new CompressionStream("gzip"));
  return new Response(stream).blob();
}

/** Link to a room for sharing: the server serves `/CODE` as an invite. */
function inviteUrl(code: string): string {
  return `${location.origin}/${code}`;
}

export const roomScreen: ScreenFactory = (ctx: AppCtx) => {
  let st: AppState = ctx.store.state;
  let alive = true;
  let builtins: BuiltinMap[] | null = null;
  let mapsError: string | null = null;
  let lastMapName: string | null = null;
  let drawnCode: string | null = null;
  let closeLibrary: (() => void) | null = null;
  let closePicker: (() => void) | null = null;
  /** Friend relations with the signed-in viewer, by lowercase name; the roster shows them. */
  let relations = new Map<string, FriendState>();
  let relationsSeq = 0;

  /** Chat messages sent from this screen, oldest first; `historyAt` is -1 when not recalling. */
  const sentHistory: string[] = [];
  let historyAt = -1;
  let draft = "";
  let lastTypingSent = Number.NEGATIVE_INFINITY;
  /** What the chat log was last built from; it is rebuilt only when one of these changes. */
  let shownChat: { list: readonly ChatLine[]; myId: number | null; host: boolean; filter: boolean } | null = null;

  const isHost = (): boolean =>
    st.room !== null && st.room.quick === null && st.room.players.some((p) => p.id === st.myId && p.host);

  // Actions. Host-only messages are guarded here as well as disabled in the DOM.
  const leave = (): void => ctx.send({ t: "leave_room" });
  const kick = (player: number, ban: boolean): void => {
    if (isHost()) ctx.send({ t: "kick", player, ban });
  };
  const giveHost = (player: number): void => {
    if (isHost()) ctx.send({ t: "give_host", player });
  };
  const moveTo = (player: number, team: number): void => {
    if (isHost()) ctx.send({ t: "move_player", player, team });
  };
  const setLock = (locked: boolean): void => {
    if (isHost()) ctx.send({ t: "set_lock", locked });
  };
  const endMatch = (): void => {
    if (isHost()) ctx.send({ t: "end_match" });
  };
  const unban = (name: string): void => {
    if (isHost()) ctx.send({ t: "unban", name });
  };
  const start = (): void => {
    if (isHost()) ctx.send({ t: "start" });
  };
  const abortStart = (): void => {
    if (isHost()) ctx.send({ t: "abort_start" });
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
  const playOnJukebox = (video: string): void => {
    if (isHost()) ctx.send({ t: "jukebox", action: "play", video });
  };

  const toastError = (err: unknown): void => ctx.toast(errorMessage(err), "error");

  /** Loads the viewer's friend relations for the roster; the latest request wins. */
  function loadFriends(): Promise<void> {
    const seq = ++relationsSeq;
    if (st.account === null) {
      relations = new Map();
      refreshPlayers();
      return Promise.resolve();
    }
    return listFriends().then(
      (list) => {
        if (!alive || seq !== relationsSeq) return;
        relations = new Map<string, FriendState>(list.map((f): [string, FriendState] => [f.name.toLowerCase(), f.state]));
        refreshPlayers();
      },
      (err: unknown) => {
        if (alive && seq === relationsSeq) toastError(err);
      },
    );
  }

  /** Runs a friend action from the roster, toasts its result, then reloads the relations. */
  function friendAction(run: () => Promise<void>, done: string): void {
    void run().then(() => ctx.toast(done), toastError).then(loadFriends);
  }

  /** Friend controls for a signed-in player on the roster, shaped by the relation with the viewer. */
  function friendControls(name: string): Node[] {
    const rel = relations.get(name.toLowerCase());
    if (rel === undefined) {
      return [
        h(
          "button",
          { type: "button", class: "room-btn room-btn-small", onclick: () => friendAction(() => requestFriend(name), `Friend request sent to ${name}.`) },
          "Add friend",
        ),
      ];
    }
    if (rel === "incoming") {
      return [
        h("span", { class: "room-friend-request", title: "sent you a friend request", "aria-label": `${name} sent you a friend request` }, "!"),
        h(
          "button",
          { type: "button", class: "room-btn room-btn-small", onclick: () => friendAction(() => acceptFriend(name), `You and ${name} are now friends.`) },
          "Accept",
        ),
        h(
          "button",
          { type: "button", class: "room-btn room-btn-small", onclick: () => friendAction(() => removeFriend(name), `Declined ${name}'s request.`) },
          "Decline",
        ),
      ];
    }
    if (rel === "friend") {
      return [
        h("span", { class: "room-badge is-friend", title: "friend" }, "Friend"),
        h(
          "button",
          { type: "button", class: "room-btn room-btn-small", onclick: () => friendAction(() => removeFriend(name), `Removed ${name} from friends.`) },
          "Remove",
        ),
      ];
    }
    return [h("button", { type: "button", class: "room-btn room-btn-small", disabled: true }, "Request sent")];
  }

  /** Opens the appearance colour picker; the saved colour is kept locally and sent to the room. */
  function openAppearance(): void {
    closePicker?.();
    const me = st.room?.players.find((p) => p.id === st.myId);
    closePicker = openColorPicker(me?.color ?? prefs.value.color ?? 0x888888, (color) => {
      closePicker = null;
      prefs.set({ color });
      ctx.send({ t: "set_color", color });
    });
  }

  /** Sends a typing signal, at most once per TYPING_SEND_MS. */
  function typingSignal(): void {
    const now = performance.now();
    if (now - lastTypingSent < TYPING_SEND_MS) return;
    lastTypingSent = now;
    ctx.send({ t: "typing" });
  }

  /** Opens the map editor for the host: the editor can send its map back to this room. */
  function openEditor(): void {
    if (!isHost()) return;
    ctx.store.set({ editorForRoom: true, screen: "editor" });
    ctx.send({ t: "editing", open: true });
  }

  /** Share the invite link: the system share sheet when there is one, else copy to the clipboard. */
  async function shareInvite(): Promise<void> {
    const room = st.room;
    if (room === null) return;
    const url = inviteUrl(room.code);
    if (typeof navigator.share === "function") {
      try {
        await navigator.share({ title: room.name, text: `Join ${room.name} on neobox`, url });
        return;
      } catch (err: unknown) {
        if (err instanceof DOMException && err.name === "AbortError") return;
      }
    }
    try {
      await navigator.clipboard.writeText(url);
      ctx.toast("Invite link copied.");
    } catch {
      ctx.toast(url);
    }
  }

  /** Save the last finished match as a .nbreplay download. */
  async function saveReplay(): Promise<void> {
    const room = st.room;
    if (room === null) return;
    const eng = await ctx.engine();
    const json = eng.replayExport(room.players.map((p): [number, string] => [p.id, p.name]));
    if (json === null) {
      ctx.toast("no finished match to save", "error");
      return;
    }
    const blob = await gzipText(json);
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const url = URL.createObjectURL(blob);
    const link = h("a", { href: url, download: `${room.code}-${stamp}.nbreplay` });
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10_000);
  }

  const sendChat = (): void => {
    const text = chatInput.value.trim();
    if (text === "") return;
    ctx.send({ t: "chat", text });
    sentHistory.push(text);
    if (sentHistory.length > SENT_LIMIT) sentHistory.shift();
    historyAt = -1;
    chatInput.value = "";
  };

  /** Enter sends; Up/Down recall earlier messages and return to the draft. */
  function chatKey(e: KeyboardEvent): void {
    if (e.isComposing) return;
    if (e.key === "Enter") {
      sendChat();
    } else if (e.key === "ArrowUp" && sentHistory.length > 0) {
      e.preventDefault();
      if (historyAt === -1) {
        draft = chatInput.value;
        historyAt = sentHistory.length - 1;
      } else {
        historyAt = Math.max(0, historyAt - 1);
      }
      chatInput.value = sentHistory[historyAt] ?? "";
    } else if (e.key === "ArrowDown" && historyAt !== -1) {
      e.preventDefault();
      if (historyAt < sentHistory.length - 1) {
        historyAt += 1;
        chatInput.value = sentHistory[historyAt] ?? "";
      } else {
        historyAt = -1;
        chatInput.value = draft;
      }
    }
  }

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

  /** Pick a map from the library: the server loads its code, names it and counts the play. */
  function openLibrary(): void {
    closeLibrary?.();
    closeLibrary = openLibraryPicker(ctx, (m) => {
      closeLibrary = null;
      if (!isHost() || !showPreview(m.code)) return;
      ctx.send({ t: "set_library_map", id: m.id });
    });
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

  /** The library map's author, votes and age, when the room's map comes from the library. */
  function buildMapInfo(room: RoomState): Node[] {
    const m = room.map;
    if (m === null) return [];
    const nodes: Node[] = [h("p", { class: "room-map-meta" }, `by ${m.author} · ${m.up} up · ${m.down} down · added ${ageText(m.created)}`)];
    if (m.description !== "") nodes.push(h("p", { class: "room-map-desc" }, m.description));
    return nodes;
  }

  // Static DOM. Sections are built once; their contents are rebuilt by the keyed renderers.
  const header = h("header", { class: "room-header" });
  const notice = h("p", { class: "room-notice", role: "status" });
  const startNotice = h("div", { class: "room-starting", role: "status" });

  const playersBody = h("div", { class: "room-players-body" });
  const renderPlayers = keyed(playersBody, buildPlayers);
  const playersPanel = h("section", { class: "room-panel room-players" }, h("h2", { class: "room-panel-title" }, "Players"), playersBody);

  const modeBody = h("div", { class: "room-mode-body" });
  const renderMode = keyed(modeBody, buildMode);
  const modePanel = h("section", { class: "room-panel room-mode-panel" }, h("h2", { class: "room-panel-title" }, "Mode"), modeBody);

  const mapName = h("p", { class: "room-map-name" });
  const mapInfo = h("div", { class: "room-map-info" });
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
      h("button", { type: "button", class: "room-btn", onclick: openLibrary }, "Library"),
      h("button", { type: "button", class: "room-btn", onclick: openEditor }, "Editor"),
      h("label", { class: "room-file" }, "Load file", fileInput),
    ),
  );
  const mapPanel = h(
    "section",
    { class: "room-panel room-map-panel" },
    h("h2", { class: "room-panel-title" }, "Map"),
    mapName,
    mapInfo,
    mapCanvas,
    mapControls,
  );

  const manageBody = h("div", { class: "room-manage-body" });
  const renderManage = keyed(manageBody, buildManage);
  const managePanel = h("section", { class: "room-panel room-manage" }, h("h2", { class: "room-panel-title" }, "Manage"), manageBody);

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
      if (e instanceof KeyboardEvent) chatKey(e);
    },
    oninput: typingSignal,
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
    h("div", { class: "room-col" }, chatPanel, managePanel, settingsPanel),
  );
  const root = h("div", { class: "room-screen" }, header, notice, startNotice, main);

  // Section builders. Each reads `st`, which is set before any render runs.

  function buildHeader(room: RoomState): Node[] {
    return [
      h(
        "div",
        { class: "room-heading" },
        h("h1", { class: "room-title" }, room.name),
        h(
          "div",
          { class: "room-heading-actions" },
          // the lobby opened from the match menu: the match keeps running behind it
          st.inMatch
            ? h("button", { type: "button", class: "room-btn room-btn-primary", onclick: () => ctx.store.set({ screen: "match" }) }, "Back to game")
            : null,
          h("button", { type: "button", class: "room-btn", onclick: () => void shareInvite() }, "Invite"),
          st.replayReady
            ? h(
                "button",
                { type: "button", class: "room-btn", onclick: () => void saveReplay().catch(toastError) },
                "Save replay",
              )
            : null,
          h("button", { type: "button", class: "room-btn", onclick: leave }, "Leave"),
        ),
      ),
      h(
        "dl",
        { class: "room-facts" },
        fact("Code", room.code),
        fact("Map", room.map_name),
        fact("Mode", modeName(roomMode(room))),
        fact("Players", `${room.players.length} / ${room.max_players}`),
        room.quick === null ? null : fact("Type", "Quick play"),
      ),
    ];
  }

  /** Team picker for one player (host only): the team columns this mode uses. */
  function teamSelect(p: PlayerInfo, teams: boolean): HTMLSelectElement {
    const current = columnOf(p, teams);
    const actions = teams ? TEAM_ACTIONS_TEAMS : TEAM_ACTIONS_FFA;
    const select: HTMLSelectElement = h(
      "select",
      {
        class: "room-team-select",
        "aria-label": `team for ${p.name}`,
        onchange: () => moveTo(p.id, Number(select.value)),
      },
      actions.map((a) => h("option", { value: String(a.team), selected: a.team === current }, a.label)),
    );
    return select;
  }

  function playerRow(p: PlayerInfo, host: boolean, teams: boolean, typing: boolean): HTMLElement {
    const isMe = p.id === st.myId;
    const ping = p.ping_ms >= 0 ? `${p.ping_ms} ms` : "-";
    return h(
      "li",
      { class: isMe ? "room-player is-me" : "room-player" },
      h("span", { class: "room-swatch", style: `background:${cssHex(p.color)}`, "aria-hidden": "true" }),
      h("span", { class: "room-player-name" }, p.name),
      isMe ? h("span", { class: "room-you" }, "you") : null,
      p.host ? h("span", { class: "room-host", title: "room host" }, "host") : null,
      p.account ? h("span", { class: "room-badge is-verified", title: "signed-in account" }, "verified") : null,
      h("span", { class: "room-level", title: p.level > 0 ? "account level" : "playing as a guest" }, p.level > 0 ? `Level ${p.level}` : "Guest"),
      typing ? h("span", { class: "room-typing", title: "typing", "aria-label": `${p.name} is typing` }, "...") : null,
      p.editing ? h("span", { class: "room-editing", title: "building a map" }, "editing") : null,
      p.connected ? null : h("span", { class: "room-badge is-offline", title: "reconnecting" }, "offline"),
      h("span", { class: "room-ping" }, ping),
      ...(st.account !== null && p.account && !isMe ? friendControls(p.name) : []),
      host && !isMe
        ? h(
            "span",
            { class: "room-player-actions" },
            teamSelect(p, teams),
            h("button", { type: "button", class: "room-btn room-btn-small", onclick: () => giveHost(p.id) }, "Make host"),
            h("button", { type: "button", class: "room-btn room-btn-small", onclick: () => kick(p.id, false) }, "Kick"),
            h("button", { type: "button", class: "room-btn room-btn-small room-btn-danger", onclick: () => kick(p.id, true) }, "Ban"),
          )
        : null,
    );
  }

  /** Ids of players whose typing signal is recent, sorted. Part of the roster key so the roster refreshes when it changes. */
  function activeTypers(): number[] {
    const now = performance.now();
    return Object.entries(st.typing)
      .filter(([, at]) => now - at < TYPING_SHOW_MS)
      .map(([id]) => Number(id))
      .sort((a, b) => a - b);
  }

  /** Rebuilds the roster when anything it shows has changed. */
  function refreshPlayers(): void {
    const room = st.room;
    if (room === null) return;
    const mode = roomMode(room);
    renderPlayers(
      JSON.stringify([room.players, st.myId, mode, isHost(), room.in_match, room.starting, st.account !== null, activeTypers(), Array.from(relations)]),
    );
  }

  function buildPlayers(): Node[] {
    const room = st.room;
    if (room === null) return [];
    const mode = roomMode(room);
    const teams = mode !== null && isTeamMode(mode);
    const host = isHost();
    const typers = new Set(activeTypers());
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
              : h("ul", { class: "room-list" }, members.map((p) => playerRow(p, host, teams, typers.has(p.id)))),
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
        h("button", { type: "button", class: "room-btn", onclick: openAppearance }, "Appearance"),
      ),
      ...(host
        ? [
            h(
              "div",
              { class: "room-actions" },
              h(
                "button",
                {
                  type: "button",
                  class: "room-btn room-btn-primary",
                  disabled: room.in_match || room.starting,
                  onclick: start,
                },
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
    return [
      h(
        "div",
        { class: "room-actions room-mode-buttons" },
        GAME_MODES.map((m) => {
          const current = m.id === mode;
          return h(
            "button",
            {
              type: "button",
              class: current ? "room-btn is-current" : "room-btn",
              "aria-pressed": current ? "true" : "false",
              onclick: () => setMode(m.id),
            },
            m.name,
          );
        }),
      ),
    ];
  }

  /** Host-only room controls: team lock, end the running match, and the ban list. */
  function buildManage(): Node[] {
    const room = st.room;
    if (room === null || !isHost()) return [];
    return [
      h(
        "div",
        { class: "room-actions" },
        h(
          "button",
          {
            type: "button",
            class: room.locked ? "room-btn is-current" : "room-btn",
            "aria-pressed": room.locked ? "true" : "false",
            onclick: () => setLock(!room.locked),
          },
          room.locked ? "Unlock teams" : "Lock teams",
        ),
        h(
          "button",
          { type: "button", class: "room-btn room-btn-danger", disabled: !room.in_match, onclick: endMatch },
          "End match",
        ),
      ),
      h("p", { class: "room-muted" }, room.locked ? "Players cannot change team." : "Players can change team."),
      h("h3", { class: "room-subtitle" }, "Bans"),
      room.bans.length === 0
        ? h("p", { class: "room-muted" }, "No bans.")
        : h(
            "ul",
            { class: "room-list room-bans" },
            room.bans.map((name) =>
              h(
                "li",
                { class: "room-ban" },
                h("span", { class: "room-player-name" }, name),
                h("button", { type: "button", class: "room-btn room-btn-small", onclick: () => unban(name) }, "Unban"),
              ),
            ),
          ),
    ];
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
    startNotice.hidden = room === null || !room.starting;
    if (room === null) return;

    const host = isHost();
    const mode = roomMode(room);
    lastMapName = room.map_name;
    previewRoomMap();
    header.replaceChildren(...buildHeader(room));
    startNotice.replaceChildren(
      h("span", null, "Match starting"),
      ...(host ? [h("button", { type: "button", class: "room-btn room-btn-small", onclick: abortStart }, "Abort start")] : []),
    );
    refreshPlayers();
    renderMode(`${host}|${mode}`);
    mapName.textContent = room.map_name;
    mapInfo.replaceChildren(...buildMapInfo(room));
    mapControls.hidden = !host;
    managePanel.hidden = !host;
    renderManage(`${host}|${room.locked}|${room.in_match}|${room.bans.join("\n")}`);
    // Map buttons carry no input state, so rebuilding them on every room render is safe.
    mapList.replaceChildren(...buildMapList());
    renderSettings(`${host}|${JSON.stringify(room.settings)}`);
  }

  /** Rebuilds the chat log only when its lines, the viewer's identity or host status, or the profanity filter changed. */
  function renderChat(): void {
    const host = isHost();
    const filter = prefs.value.filterProfanity;
    if (shownChat !== null && shownChat.list === st.chat && shownChat.myId === st.myId && shownChat.host === host && shownChat.filter === filter) {
      return;
    }
    const listChanged = shownChat === null || shownChat.list !== st.chat;
    shownChat = { list: st.chat, myId: st.myId, host, filter };
    chatLog.replaceChildren(
      ...st.chat.map((line) => {
        // Other players' lines are masked when the viewer filters profanity; their own lines show as typed.
        const masked = line.from !== null && line.from !== st.myId && prefs.value.filterProfanity;
        return chatLine(line, st.myId, masked ? filterProfanity(line.text) : line.text, host ? playOnJukebox : null);
      }),
    );
    if (listChanged) chatLog.scrollTop = chatLog.scrollHeight;
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

  // The roster's friend controls need the viewer's relations; load them on entry.
  void loadFriends();

  // Typing signals expire on their own: refresh the roster when one does.
  const typingTimer = setInterval(refreshPlayers, TYPING_TICK_MS);
  const unsubPrefs = prefs.subscribe(renderChat);

  return {
    el: root,
    update(next, prev) {
      st = next;
      if (next.account !== prev.account) void loadFriends();
      if (
        next.room !== prev.room ||
        next.myId !== prev.myId ||
        next.inMatch !== prev.inMatch ||
        next.replayReady !== prev.replayReady ||
        next.account !== prev.account
      ) {
        renderRoom();
      } else if (next.typing !== prev.typing) {
        refreshPlayers();
      }
      renderChat();
    },
    destroy() {
      alive = false;
      clearInterval(typingTimer);
      unsubPrefs();
      closeLibrary?.();
      closeLibrary = null;
      closePicker?.();
      closePicker = null;
    },
  };
};
