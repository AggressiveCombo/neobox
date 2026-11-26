// Room lobby: header, notice, players and team actions, mode, map, host manage, settings and chat.
// Room-derived sections rebuild only when the inputs they read change, so settings
// inputs and draft text survive unrelated room updates.

import { h, labelSwap, showLabel } from "../dom";
import type { AppCtx, ScreenFactory } from "../../ctx";
import { sendReport, type BuiltinMap } from "../../api";
import type { AppState, ChatLine } from "../../state";
import {
  GAME_MODES,
  MAX_CHAT_LEN,
  TEAM_BLUE,
  TEAM_FFA,
  TEAM_RED,
  TEAM_SPECTATOR,
  ROOM_MIN_PLAYERS,
  isTeamMode,
} from "../../protocol";
import type { MapMeta, PlayerInfo, RoomState } from "../../protocol";
import { SETTINGS, formatValue, normalizeInput, readOnlyKeys, readOnlyLabel } from "../../settings";
import type { SettingDef } from "../../settings";
import { drawMapPreview } from "../../render/preview";
import { openLibraryPicker } from "../library-picker";
import { avatar, field, openModal, seg, uid, type SegOption } from "../kit";
import {
  acceptFriend,
  errorText,
  listFriends,
  listRecords,
  removeFriend,
  requestFriend,
  type FriendState,
  type MapRecord,
} from "../../account";
import { filterProfanity } from "../../profanity";
import { prefs } from "../../prefs";
import { openColorPicker } from "../color-picker";
import { icon, type IconName } from "../icons";
import { showProfile } from "../profile";

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

/** The icon of each game mode, shown on its mode button. */
const MODE_ICONS: Record<number, IconName> = {
  0: "swords",
  1: "heart",
  2: "timer",
  3: "flag",
  4: "users",
  5: "shield",
  6: "infinity",
};

/** One line on what each game mode means, shown in the mode picker. */
const MODE_BLURBS: Record<number, string> = {
  0: "Ranked by kills.",
  1: "Each player has lives; the last one left wins.",
  2: "Play rounds; the most round wins takes the match.",
  3: "Red and Blue play rounds; the team with more round wins takes the match.",
  4: "Red and Blue score kills endlessly, or deliver objectives to win on objective maps.",
  5: "Red and Blue share lives; the last team with lives left wins.",
  6: "Score kills in an endless match.",
};

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

/** The original's game clock: records are ticks, shown as seconds at two decimals. */
const TICKS_PER_SECOND = 30;

/** The table of a map's Fastest Times, fastest first. */
function recordsTable(rows: MapRecord[]): HTMLElement {
  return h(
    "table",
    { class: "data records-table" },
    h(
      "thead",
      null,
      h(
        "tr",
        null,
        h("th", { scope: "col", class: "num" }, "Rank"),
        h("th", { scope: "col" }, "Name"),
        h("th", { scope: "col", class: "num" }, "Time"),
        h("th", { scope: "col" }, "Date"),
      ),
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
          h("td", { class: "num" }, (r.ticks / TICKS_PER_SECOND).toFixed(2)),
          h("td", null, ageText(r.date)),
        ),
      ),
    ),
  );
}

/** The Fastest Times window for a library map. Close, Escape or the backdrop dismisses it. */
function showFastestTimes(map: MapMeta): void {
  const status = h("p", { class: "room-muted", role: "status", "aria-live": "polite" }, "Fetching...");
  const body = h("div", { class: "records-body" });
  const { dialog } = openModal({
    title: "Fastest Times",
    body: [h("p", { class: "room-muted" }, `${map.name} by ${map.author}`), status, body],
  });
  listRecords(map.id).then(
    (rows) => {
      if (!dialog.isConnected) return;
      if (rows.length === 0) {
        status.textContent = "No Records";
        return;
      }
      status.textContent = "";
      body.replaceChildren(recordsTable(rows));
    },
    (err: unknown) => {
      if (dialog.isConnected) status.textContent = errorText(err);
    },
  );
}

function chatLine(line: ChatLine, myId: number | null, text: string, onPlay: ((video: string) => void) | null): HTMLElement {
  const display = text === " " ? "\u00A0" : text;
  if (line.from === null) return h("div", { class: "room-chat-line room-chat-system" }, display);
  const mine = line.from === myId ? "room-chat-line is-me" : "room-chat-line";
  const suggest = line.suggest;
  return h(
    "div",
    { class: mine },
    h("span", { class: "room-chat-name" }, line.name),
    ": ",
    display,
    suggest
      ? h(
          "div",
          { class: "room-chat-suggest" },
          h("span", null, `suggests ${suggest.title}`),
          onPlay ? h("button", { type: "button", class: "room-btn quiet", onclick: () => onPlay(suggest.video) }, icon("play", 16), "Play on jukebox") : null,
        )
      : null,
  );
}

/** Ping quality tier for the roster bars: under 80 ms good, under 160 fair, otherwise poor. */
function pingTier(ms: number): string {
  if (ms < 0) return "is-none";
  if (ms < 80) return "is-good";
  return ms < 160 ? "is-fair" : "is-poor";
}

/**
 * Rebuilds `slot` only when `key` differs from the previous call. A rebuild keeps the scroll position of the
 * slot's scrolling ancestors, and returns focus to the rebuilt control with the same `data-focus-key`.
 */
function keyed(slot: HTMLElement, build: () => Node[]): (key: string) => void {
  let last: string | null = null;
  return (key) => {
    if (key === last) return;
    last = key;
    const active = document.activeElement;
    const focusKey = active instanceof HTMLElement && slot.contains(active) ? (active.dataset.focusKey ?? null) : null;
    const scrolled: [HTMLElement, number][] = [];
    for (let el = slot.parentElement; el !== null; el = el.parentElement) {
      if (el.scrollTop > 0) scrolled.push([el, el.scrollTop]);
    }
    slot.replaceChildren(...build());
    for (const [el, top] of scrolled) el.scrollTop = top;
    if (focusKey !== null) {
      for (const el of slot.querySelectorAll<HTMLElement>("[data-focus-key]")) {
        if (el.dataset.focusKey === focusKey) {
          el.focus({ preventScroll: true });
          break;
        }
      }
    }
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
  /** The map name whose code was last asked of the server for the preview. */
  let previewAsked: string | null = null;
  let closeLibrary: (() => void) | null = null;
  let closePicker: (() => void) | null = null;
  let closeMapPicker: (() => void) | null = null;
  let closeModePicker: (() => void) | null = null;
  /** Friend relations with the signed-in viewer, by lowercase name; the roster shows them. */
  let relations = new Map<string, FriendState>();
  let relationsSeq = 0;
  /** The roster player whose action menu is open, if any. */
  let menuFor: number | null = null;

  /** Chat messages sent from this screen, oldest first; `historyAt` is -1 when not recalling. */
  const sentHistory: string[] = [];
  let historyAt = -1;
  let draft = "";
  let lastTypingSent = Number.NEGATIVE_INFINITY;
  /** What the chat log was last built from; it is rebuilt only when one of these changes. */
  let shownChat: { list: readonly ChatLine[]; count: number; last: ChatLine | null; myId: number | null; host: boolean; filter: boolean } | null = null;

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

  /** Friend chip on a roster row: a pending request to the viewer, or the friend badge. */
  function friendChip(name: string): HTMLElement | null {
    const rel = relations.get(name.toLowerCase());
    if (rel === "incoming") {
      return h("span", { class: "chip room-friend-request", title: "sent you a friend request", "aria-label": `${name} sent you a friend request` }, icon("user-plus", 14), "Request");
    }
    return rel === "friend" ? h("span", { class: "chip", title: "friend" }, icon("users", 14), "Friend") : null;
  }

  /** Friend actions for a roster row's menu, shaped by the relation with the viewer. */
  function friendMenuItems(name: string): HTMLElement[] {
    const rel = relations.get(name.toLowerCase());
    if (rel === undefined) {
      return [menuItem("Add friend", () => friendAction(() => requestFriend(name), `Friend request sent to ${name}.`), { icon: "user-plus" })];
    }
    if (rel === "incoming") {
      return [
        menuItem("Accept", () => friendAction(() => acceptFriend(name), `You and ${name} are now friends.`), { icon: "user-check" }),
        menuItem("Decline", () => friendAction(() => removeFriend(name), `Declined ${name}'s request.`), { icon: "user-x" }),
      ];
    }
    if (rel === "friend") {
      return [menuItem("Remove friend", () => friendAction(() => removeFriend(name), `Removed ${name} from friends.`), { icon: "user-x" })];
    }
    return [menuItem("Request sent", null)];
  }

  /** Report a roster player: a reason and optional details, filed with this room's code. */
  function openPlayerReport(p: PlayerInfo): void {
    const room = st.room;
    if (room === null) return;
    type Reason = "Harassment" | "Offensive name" | "Cheating" | "Other";
    const reasons: SegOption<Reason>[] = (["Harassment", "Offensive name", "Cheating", "Other"] as const).map((r) => ({ value: r, label: r }));
    let reason: Reason = "Harassment";
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
            await sendReport({ kind: "player", room: room.code, player: p.id, reason: extra === "" ? reason : `${reason}: ${extra}` });
            modal?.close();
            ctx.toast(`Thanks. An admin will look at ${p.name}.`);
          } catch (err: unknown) {
            formError.textContent = errorText(err);
          } finally {
            sending = false;
            send.disabled = false;
          }
        },
      },
      h("p", { class: "field-hint" }, `Tell an admin what ${p.name} did.`),
      seg("Reason", reasons, reason, (v) => {
        reason = v;
      }).el,
      field("Details (optional)", details),
      formError,
    );
    modal = openModal({ title: `Report ${p.name}`, body: [form], actions: [cancel, send] });
  }

  /** Opens the roster action menu for a player (null closes it); `focusFirst` moves focus into it. */
  function setMenu(id: number | null, focusFirst = false): void {
    menuFor = id;
    refreshPlayers();
    if (focusFirst) playersBody.querySelector<HTMLElement>(".room-menu-item:not(:disabled)")?.focus();
  }

  const triggerOf = (id: number): HTMLElement | null =>
    playersBody.querySelector<HTMLElement>(`.room-player-tools[data-player="${id}"] .room-more`);

  /** Outside presses close the roster menu; presses on its own trigger or menu do not. */
  function onMenuOutside(e: Event): void {
    const target = e.target;
    if (menuFor === null || !(target instanceof Element)) return;
    if (target.closest(`.room-player-tools[data-player="${menuFor}"]`) !== null) return;
    setMenu(null);
  }

  /** Escape closes the roster menu and returns focus to its trigger; arrows move between its items. */
  function onMenuKey(e: KeyboardEvent): void {
    if (menuFor === null) return;
    if (e.key === "Escape") {
      const id = menuFor;
      setMenu(null);
      triggerOf(id)?.focus();
    } else if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      const items = Array.from(playersBody.querySelectorAll<HTMLElement>(".room-menu-item:not(:disabled)"));
      if (items.length === 0) return;
      e.preventDefault();
      const at = items.indexOf(document.activeElement as HTMLElement);
      const step = e.key === "ArrowDown" ? 1 : -1;
      items[at === -1 ? 0 : (at + step + items.length) % items.length]?.focus();
    }
  }

  /** One roster action-menu item. Choosing it closes the menu, then runs `run`; a null `run` leaves it disabled. */
  function menuItem(label: string, run: (() => void) | null, opts: { role?: string; checked?: boolean; danger?: boolean; icon?: IconName } = {}): HTMLElement {
    return h(
      "button",
      {
        type: "button",
        class: opts.danger ? "room-menu-item list-row is-danger" : "room-menu-item list-row",
        role: opts.role ?? "menuitem",
        "aria-checked": opts.checked === undefined ? undefined : String(opts.checked),
        disabled: run === null,
        onclick: () => {
          setMenu(null);
          run?.();
        },
      },
      opts.icon ? icon(opts.icon, 16) : null,
      label,
    );
  }

  /** Actions for one roster row: host controls (make host, team moves, kick, ban), friend actions, then Report. */
  function rowMenuItems(p: PlayerInfo, host: boolean, teams: boolean): HTMLElement[] {
    const items: HTMLElement[] = [];
    if (host) {
      items.push(menuItem("Make host", () => giveHost(p.id), { icon: "crown" }));
      for (const a of teams ? TEAM_ACTIONS_TEAMS : TEAM_ACTIONS_FFA) {
        items.push(menuItem(a.label, () => moveTo(p.id, a.team), { role: "menuitemradio", checked: p.team === a.team }));
      }
    }
    if (p.account) items.push(menuItem("View profile", () => showProfile(ctx, p.name), { icon: "user" }));
    if (st.account !== null && p.account) items.push(...friendMenuItems(p.name));
    if (host) {
      items.push(menuItem("Kick", () => kick(p.id, false), { icon: "user-x" }));
      items.push(menuItem("Ban", () => kick(p.id, true), { danger: true, icon: "ban" }));
    }
    items.push(menuItem("Report", () => openPlayerReport(p), { icon: "flag" }));
    return items;
  }

  /** One roster row on one line: avatar, name and its marks, level and ping, and the action menu for other players. */
  function playerRow(p: PlayerInfo, host: boolean, teams: boolean, typing: boolean): HTMLElement {
    const isMe = p.id === st.myId;
    const open = menuFor === p.id;
    return h(
      "li",
      { class: isMe ? "room-player is-me" : "room-player" },
      avatar(p.name, p.color),
      h(
        "div",
        { class: "room-player-line" },
        p.account
          ? h("button", { type: "button", class: "room-player-name room-profile-link", title: "View profile", onclick: () => showProfile(ctx, p.name) }, p.name)
          : h("span", { class: "room-player-name" }, p.name),
        p.host ? h("span", { class: "room-host-mark", role: "img", title: "Room host", "aria-label": "Room host" }, icon("crown", 14)) : null,
        p.account ? h("span", { class: "room-verified", role: "img", title: "Verified account", "aria-label": "Verified account" }, icon("badge-check", 14)) : null,
        isMe ? h("span", { class: "room-you" }, "you") : null,
        st.account !== null && p.account && !isMe ? friendChip(p.name) : null,
        typing ? h("span", { class: "room-typing" }, h("span", { class: "room-sr" }, `${p.name} is `), "typing…") : null,
        p.editing ? h("span", { class: "room-editing", title: "building a map" }, "editing") : null,
        p.connected ? null : h("span", { class: "room-offline", title: "reconnecting" }, "Reconnecting"),
      ),
      h(
        "div",
        { class: "room-player-stats" },
        p.level > 0 ? h("span", { class: "room-level", title: "account level" }, `Lv ${p.level}`) : null,
        h("span", { class: "room-ping", "data-ping": String(p.id) }, icon("signal", 14), h("span", { class: "room-ping-text" })),
      ),
      isMe
        ? null
        : h(
            "div",
            { class: "room-player-tools", "data-player": String(p.id) },
            h(
              "button",
              {
                type: "button",
                class: "room-more",
                "data-focus-key": `more:${p.id}`,
                "aria-label": `Actions for ${p.name}`,
                "aria-haspopup": "menu",
                "aria-expanded": open ? "true" : "false",
                onclick: () => (open ? setMenu(null) : setMenu(p.id, true)),
              },
              icon("ellipsis", 18),
            ),
            open ? h("div", { class: "room-menu", role: "menu", "aria-label": `Actions for ${p.name}` }, rowMenuItems(p, host, teams)) : null,
          ),
    );
  }

  /** Rebuilds the roster when anything it shows has changed. */
  function refreshPlayers(): void {
    const room = st.room;
    if (room === null) return;
    if (menuFor !== null && !room.players.some((p) => p.id === menuFor)) menuFor = null;
    const mode = roomMode(room);
    renderPlayers(
      JSON.stringify([
        // ping changes every broadcast: it repaints in place (paintPings) instead of rebuilding the roster
        room.players.map(({ ping_ms: _ping, ...p }) => p),
        st.myId,
        mode,
        isHost(),
        room.in_match,
        room.starting,
        st.account !== null,
        st.reconnecting,
        activeTypers(),
        Array.from(relations),
        menuFor,
      ]),
    );
    paintPings(room);
  }

  /** Sets each roster ping to the room's latest figure. */
  function paintPings(room: RoomState): void {
    for (const p of room.players) {
      const el = playersBody.querySelector<HTMLElement>(`[data-ping="${p.id}"]`);
      if (el === null) continue;
      el.className = `room-ping ${pingTier(p.ping_ms)}`;
      el.title = p.ping_ms >= 0 ? "ping" : "no ping";
      const text = el.querySelector(".room-ping-text");
      if (text !== null) text.textContent = p.ping_ms >= 0 ? `${p.ping_ms} ms` : "-";
    }
  }

  function buildPlayers(): Node[] {
    const room = st.room;
    if (room === null) return [];
    const mode = roomMode(room);
    const teams = mode !== null && isTeamMode(mode);
    const host = isHost();
    const typers = new Set(activeTypers());
    const me = room.players.find((p) => p.id === st.myId);
    const teamActions = teams ? TEAM_ACTIONS_TEAMS : TEAM_ACTIONS_FFA;
    const members = (bucket: number): PlayerInfo[] => room.players.filter((p) => columnOf(p, teams) === bucket);
    const list = (ps: PlayerInfo[]): HTMLElement =>
      h("ul", { class: "room-roster-list" }, ps.map((p) => playerRow(p, host, teams, typers.has(p.id))));
    const nodes: Node[] = [
      h(
        "div",
        { class: "room-players-head" },
        h("h2", { class: "panel-title" }, "Players", h("span", { class: "room-count" }, `${room.players.length}/${room.max_players}`)),
        h(
          "div",
          { class: "room-team-pick" },
          seg(
            teams ? "Your team" : "Join or spectate",
            teamActions.map((a) => ({ value: String(a.team), label: a.label, disabled: st.reconnecting })),
            String(me?.team ?? ""),
            (v) => ctx.send({ t: "set_team", team: Number(v) }),
          ).el,
        ),
        h("button", { type: "button", class: "icon room-appearance", "aria-label": "Appearance", title: "Appearance", onclick: openAppearance }, icon("palette", 18)),
      ),
    ];
    if (teams) {
      for (const [title, bucket] of [
        ["Red", TEAM_RED],
        ["Blue", TEAM_BLUE],
      ] as const) {
        const ps = members(bucket);
        nodes.push(
          h(
            "section",
            { class: "room-roster-group" },
            h("h3", { class: "panel-sub" }, `${title} (${ps.length})`),
            ps.length === 0 ? h("p", { class: "room-muted" }, `No one on ${title}`) : list(ps),
          ),
        );
      }
    } else {
      const ps = members(TEAM_FFA);
      nodes.push(ps.length === 0 ? h("p", { class: "room-muted" }, "No players yet") : list(ps));
    }
    const spectators = members(TEAM_SPECTATOR);
    if (spectators.length > 0) {
      nodes.push(h("section", { class: "room-roster-group" }, h("h3", { class: "panel-sub" }, `Spectating (${spectators.length})`), list(spectators)));
    }
    return nodes;
  }

  function buildMode(): Node[] {
    const room = st.room;
    if (room === null) return [];
    const mode = roomMode(room);
    const name = h("span", { class: "room-mode-name" }, icon(MODE_ICONS[mode ?? -1] ?? "swords", 18), modeName(mode));
    if (!isHost()) return [name];
    return [
      h(
        "div",
        { class: "room-mode-row" },
        name,
        h("button", { type: "button", class: "room-btn room-btn-small", onclick: openModePicker }, "Change mode"),
      ),
    ];
  }

  /** Host-only room controls: team lock and ending the running match. */
  function buildManage(): Node[] {
    const room = st.room;
    if (room === null || !isHost()) return [];
    return [
      h(
        "div",
        { class: "room-control" },
        h("button", { type: "button", class: "room-btn", "data-focus-key": "lock", disabled: st.reconnecting, onclick: () => setLock(!room.locked) }, icon(room.locked ? "lock-open" : "lock", 16), room.locked ? "Unlock teams" : "Lock teams"),
        h("p", { class: "room-muted" }, room.locked ? "Players cannot change team." : "Players can change team."),
      ),
      h(
        "div",
        { class: "room-danger" },
        h("button", { type: "button", class: "room-btn danger", disabled: !room.in_match, onclick: endMatch }, icon("x", 16), "End match"),
        h("p", { class: "room-muted" }, room.in_match ? "Stops the match for everyone." : "No match is running."),
      ),
    ];
  }

  /** Host-only ban list; each banned player can be unbanned. */
  function buildBans(): Node[] {
    const room = st.room;
    if (room === null || !isHost()) return [];
    if (room.bans.length === 0) return [h("p", { class: "room-muted" }, "No one is banned.")];
    return [
      h(
        "ul",
        { class: "room-bans" },
        room.bans.map((name) =>
          h(
            "li",
            { class: "room-ban" },
            h("span", { class: "room-player-name" }, name),
            h("button", { type: "button", class: "room-btn", onclick: () => unban(name) }, "Unban"),
          ),
        ),
      ),
    ];
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

  /** Copy the invite link (no system share sheet: one press, the link is on the clipboard), else show it to copy by hand. */
  async function shareInvite(): Promise<void> {
    const room = st.room;
    if (room === null) return;
    const url = inviteUrl(room.code);
    if (await copyText(url)) {
      flashInviteCopied();
      ctx.toast("Invite link copied.");
      return;
    }
    showInviteLink(url);
  }

  /**
   * Copies text. Without a secure context there is no async clipboard, so a hidden textarea is selected and copied
   * with execCommand, which still works on plain http.
   */
  async function copyText(text: string): Promise<boolean> {
    try {
      if (navigator.clipboard) {
        await navigator.clipboard.writeText(text);
        return true;
      }
    } catch {
      // fall through to the textarea copy
    }
    return copyWithTextarea(text);
  }

  function copyWithTextarea(text: string): boolean {
    const box = document.createElement("textarea");
    box.value = text;
    box.setAttribute("readonly", "");
    box.style.position = "fixed";
    box.style.opacity = "0";
    document.body.append(box);
    box.select();
    box.setSelectionRange(0, text.length);
    let ok = false;
    try {
      ok = document.execCommand("copy");
    } catch {
      ok = false;
    }
    box.remove();
    return ok;
  }

  /** Last resort when the browser will not copy: the link in a selectable field, with a button to try again. */
  function showInviteLink(url: string): void {
    const box = h("input", { type: "text", readonly: true, "aria-label": "Invite link", class: "invite-link-box" });
    box.value = url;
    const copy = h(
      "button",
      {
        type: "button",
        class: "primary",
        onclick: async () => {
          box.select();
          if (await copyText(url)) {
            ctx.toast("Invite link copied.");
            close();
          } else {
            ctx.toast("Copy did not work: select the link and copy it with Ctrl+C.", "error");
          }
        },
      },
      icon("link", 16),
      "Copy this link",
    );
    const done = h("button", { type: "button", class: "quiet", onclick: () => close() }, icon("x", 18), "Close");
    const { close } = openModal({
      title: "Copy the invite link",
      body: [h("p", null, "This connection is not secure, so the browser cannot copy for you. Select the link and copy it."), box],
      actions: [copy, done],
    });
    box.select();
  }

  /** Shows a check and "Link copied" on the invite button for a moment, so the copy reads as done. */
  function flashInviteCopied(): void {
    const swap = header.querySelector<HTMLElement>(".room-invite .label-swap");
    if (swap === null) return;
    showLabel(swap, 1);
    setTimeout(() => showLabel(swap, 0), 1600);
  }

  /** Save the last finished match as a .nbreplay download. */
  async function saveReplay(): Promise<void> {
    const room = st.room;
    if (room === null) return;
    const eng = await ctx.engine();
    const json = eng.replayExport(room.players.map((p): [number, string] => [p.id, p.name]));
    if (json === null) {
      ctx.toast("nothing has been recorded to save", "error");
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
    const raw = chatInput.value;
    if (raw.length === 0 || st.reconnecting) return;
    const trimmed = raw.trim();
    const text = trimmed === "" ? " " : trimmed;
    ctx.send({ t: "chat", text });
    sentHistory.push(text);
    if (sentHistory.length > SENT_LIMIT) sentHistory.shift();
    historyAt = -1;
    chatInput.value = "";
    syncChatSend(st.reconnecting);
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
    syncChatSend(st.reconnecting);
  }

  // The original's map vote menu: Vote Up and Vote Down send the room's /upvote and /downvote commands.
  let voteMenu: HTMLElement | null = null;

  function closeVoteMenu(): void {
    voteMenu?.remove();
    voteMenu = null;
    window.removeEventListener("pointerdown", onVoteOutside, true);
    window.removeEventListener("keydown", onVoteKey);
  }

  function onVoteOutside(e: Event): void {
    if (voteMenu !== null && !voteMenu.contains(e.target as Node)) closeVoteMenu();
  }

  function onVoteKey(e: KeyboardEvent): void {
    if (e.key === "Escape") closeVoteMenu();
  }

  function openVoteMenu(anchor: HTMLElement): void {
    closeVoteMenu();
    const menu = h(
      "div",
      { class: "room-vote-menu", role: "menu" },
      (
        [
          ["Vote Up", "/upvote", "thumbs-up"],
          ["Vote Down", "/downvote", "thumbs-down"],
        ] as const
      ).map(([label, text, name]) =>
        h(
          "button",
          {
            type: "button",
            class: "room-menu-item list-row",
            role: "menuitem",
            onclick: () => {
              ctx.send({ t: "chat", text });
              closeVoteMenu();
            },
          },
          icon(name, 16),
          label,
        ),
      ),
    );
    const rect = anchor.getBoundingClientRect();
    menu.style.left = `${rect.left}px`;
    menu.style.top = `${rect.bottom + 4}px`;
    voteMenu = menu;
    document.body.append(menu);
    window.addEventListener("pointerdown", onVoteOutside, true);
    window.addEventListener("keydown", onVoteKey);
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
      closeMapPicker?.();
    });
  }

  /** Runs a preview draw once the engine is loaded: a room that opens before the engine is not an error to show. */
  function afterEngine(draw: () => void): void {
    ctx.engine().then(
      () => {
        if (alive) draw();
      },
      () => {},
    );
  }

  /**
   * Previews the room's current map (visible to everyone): a built-in by name, otherwise the
   * code the server holds for the room (asked once per map name).
   */
  function previewRoomMap(): void {
    const name = lastMapName;
    const map = builtins?.find((m) => m.name === name);
    if (map) {
      afterEngine(() => showPreview(map.code));
      return;
    }
    if (!name || previewAsked === name) return;
    previewAsked = name;
    ctx.roomMap().then(
      ({ code }) => {
        if (alive && code !== "" && lastMapName === name) afterEngine(() => showPreview(code));
      },
      () => {},
    );
  }

  /** Opens the built-in maps in a dialog; picking one sets the room's map and closes it. */
  function openMapPicker(): void {
    closeMapPicker?.();
    const modal = openModal({
      title: "Choose a map",
      body: [mapList, mapControls],
      onclose: () => {
        closeMapPicker = null;
      },
    });
    closeMapPicker = () => modal.close();
    refreshMapList();
  }

  /** Opens the game modes in a dialog; picking one sets the room's mode and closes it. */
  function openModePicker(): void {
    closeModePicker?.();
    refreshModeList();
    const modal = openModal({
      title: "Game mode",
      body: [modeList],
      onclose: () => {
        closeModePicker = null;
      },
    });
    closeModePicker = () => modal.close();
  }

  /** The game modes as a list: icon, name, and one line on what the mode is. */
  function buildModeList(): Node[] {
    const current = st.room === null ? null : roomMode(st.room);
    return GAME_MODES.map((m) =>
      h(
        "button",
        {
          type: "button",
          class: "room-mode-option list-row",
          "data-focus-key": String(m.id),
          "aria-pressed": m.id === current ? "true" : "false",
          onclick: () => {
            setMode(m.id);
            closeModePicker?.();
          },
        },
        icon(MODE_ICONS[m.id] ?? "swords", 18),
        h("span", { class: "room-mode-text" }, h("span", { class: "room-mode-option-name" }, m.name), h("span", { class: "room-mode-option-desc" }, MODE_BLURBS[m.id] ?? "")),
      ),
    );
  }

  /** A map's preview thumbnail, drawn from its code once the engine is ready and the canvas has layout size. */
  function mapThumb(code: string): HTMLCanvasElement {
    const canvas = h("canvas", { class: "room-map-thumb", "aria-hidden": "true" });
    afterEngine(() => {
      const draw = (): void => {
        if (!alive) return;
        try {
          drawMapPreview(canvas, ctx.wasm.mapPreview(code));
        } catch {
          // no thumbnail: the name alone still picks the map
        }
      };
      if (canvas.clientWidth > 0) draw();
      else requestAnimationFrame(draw);
    });
    return canvas;
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
          "data-focus-key": map.code,
          "aria-pressed": current ? "true" : "false",
          onclick: () => {
            if (chooseMap(map.code, map.name)) closeMapPicker?.();
          },
        },
        mapThumb(map.code),
        h("span", null, map.name),
      );
    });
  }

  /**
   * The library map's author, votes and age, with the Fastest Times button. Signed-in viewers
   * open the vote menu from the counts; the button needs a library map (id > 0).
   */
  function buildMapInfo(room: RoomState): Node[] {
    const m = room.map;
    const library = m !== null && m.id > 0;
    const fastest = h(
      "button",
      {
        type: "button",
        class: "room-btn room-btn-small",
        disabled: !library,
        onclick: () => {
          if (m !== null) showFastestTimes(m);
        },
      },
      icon("trophy", 16),
      "Fastest Times",
    );
    const change = isHost() ? h("button", { type: "button", class: "room-btn room-btn-small", onclick: openMapPicker }, icon("map", 16), "Change map") : null;
    const actions = h("div", { class: "room-map-actions" }, change, fastest);
    if (m === null) return [actions];
    const counts = `${m.up} up · ${m.down} down`;
    const votes =
      st.account !== null && library
        ? h(
            "button",
            {
              type: "button",
              class: "room-map-votes",
              title: "Vote on this map",
              onclick: (e: Event) => openVoteMenu(e.currentTarget as HTMLElement),
            },
            counts,
          )
        : counts;
    const nodes: Node[] = [h("p", { class: "room-map-meta" }, `by ${m.author} · `, votes, ` · added ${ageText(m.created)}`)];
    if (m.description !== "") nodes.push(h("p", { class: "room-map-desc" }, m.description));
    nodes.push(actions);
    return nodes;
  }

  // Static DOM. Sections are built once; their contents are rebuilt by the keyed renderers.
  const header = h("header", { class: "room-header" });
  const notice = h("p", { class: "room-notice", role: "status" });
  const startNotice = h("div", { class: "room-starting", role: "status" });
  // A join waiting for the server's answer: the room's name and a Cancel that returns to the browser (or the menu).
  const joiningText = h("p", { class: "room-joining-text" });
  const joining = h(
    "section",
    { class: "room-joining", role: "status", "aria-live": "polite" },
    h("span", { class: "room-joining-dot", "aria-hidden": "true" }),
    joiningText,
    h("button", { type: "button", "data-escape": "", onclick: () => ctx.cancelJoin() }, icon("x", 18), "Cancel"),
  );
  const startButton = h("button", { type: "button", class: "room-btn primary", onclick: () => void start() }, icon("play", 16), "Start");
  const dockStatus = h("p", { class: "room-dock-status", role: "status" });
  const dock = h("footer", { class: "room-dock", "aria-label": "Match controls" }, dockStatus, h("div", { class: "room-dock-actions" }, startButton));

  // Phone: one section at a time. Desktop shows every section and ignores the tab.
  const tabNames = { players: "Players", match: "Match", chat: "Chat" } as const;
  type TabId = keyof typeof tabNames;
  const tabIcons: Record<TabId, IconName> = { players: "users", match: "gamepad-2", chat: "message-square" };
  const tabButtons = (Object.keys(tabNames) as TabId[]).map((id) =>
    h(
      "button",
      { type: "button", role: "tab", class: "tab", "data-tab": id, "aria-selected": id === "players" ? "true" : "false", onclick: () => selectTab(id) },
      icon(tabIcons[id], 16),
      tabNames[id],
    ),
  );
  const tabBar = h("nav", { class: "tabs room-tabs", role: "tablist", "aria-label": "Room sections" }, tabButtons);
  function selectTab(id: TabId): void {
    root.dataset.tab = id;
    for (const b of tabButtons) b.setAttribute("aria-selected", String(b.dataset.tab === id));
  }

  const playersBody = h("div", { class: "room-players-body" });
  const renderPlayers = keyed(playersBody, buildPlayers);
  const playersPanel = h("section", { class: "panel room-panel room-players" }, playersBody);

  const modeBody = h("div", { class: "room-mode-body" });
  const modeList = h("div", { class: "room-mode-list" });
  const renderMode = keyed(modeBody, buildMode);
  const modePanel = h("section", { class: "panel room-panel room-mode-panel" }, h("h2", { class: "panel-title" }, "Mode"), modeBody);

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
    h("h3", { class: "panel-sub" }, "Paste a map code"),
    textarea,
    h(
      "div",
      { class: "actions" },
      h(
        "button",
        {
          type: "button",
          class: "room-btn",
          onclick: () => {
            if (submitMapText(textarea.value)) {
              textarea.value = "";
              closeMapPicker?.();
            }
          },
        },
        "Use code",
      ),
      h("button", { type: "button", class: "room-btn", onclick: openLibrary }, icon("library-big", 16), "Library"),
      h("button", { type: "button", class: "room-btn", onclick: openEditor }, icon("pencil-ruler", 16), "Editor"),
      h("label", { class: "room-file" }, icon("upload", 16), "Load file", fileInput),
    ),
  );
  const mapPanel = h("section", { class: "panel room-panel room-map-panel" }, h("h2", { class: "panel-title" }, "Map"), mapCanvas, mapName, mapInfo);

  const manageBody = h("div", { class: "room-manage-body" });
  const renderManage = keyed(manageBody, buildManage);
  const managePanel = h("section", { class: "panel room-panel room-manage" }, h("h2", { class: "panel-title" }, "Manage"), manageBody);

  const bansBody = h("div", { class: "room-bans-body" });
  const renderBans = keyed(bansBody, buildBans);
  const bansPanel = h("section", { class: "panel room-panel room-bans-panel" }, h("h2", { class: "panel-title" }, "Bans"), bansBody);

  const settingsBody = h("div", { class: "room-settings-body" });
  let settingsOpen = false;
  const renderSettings = keyed(settingsBody, buildSettings);
  const settingsPanel = h("section", { class: "panel room-panel room-settings-panel" }, h("h2", { class: "panel-title" }, "Settings"), settingsBody);

  const renderHeader = keyed(header, () => (st.room === null ? [] : buildHeader(st.room)));
  const renderStartNotice = keyed(startNotice, () => startNoticeNodes(isHost()));
  const renderMapInfo = keyed(mapInfo, () => (st.room === null ? [] : buildMapInfo(st.room)));
  const renderMapList = keyed(mapList, buildMapList);
  const renderModeList = keyed(modeList, buildModeList);

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
    oninput: () => {
      typingSignal();
      syncChatSend(st.reconnecting);
    },
  });
  const chatSend = h("button", { type: "button", class: "icon", "aria-label": "Send", title: "Send", disabled: true, onclick: sendChat }, icon("send", 18));
  /** Send is off while the draft is empty (nothing to send) or the connection is being restored. */
  const syncChatSend = (reconnecting: boolean): void => {
    chatSend.disabled = reconnecting || chatInput.value.length === 0;
  };
  const chatPanel = h(
    "section",
    { class: "panel room-panel room-chat" },
    h("h2", { class: "panel-title" }, icon("message-square", 20), "Chat"),
    chatLog,
    h(
      "div",
      { class: "room-chat-form" },
      chatInput,
      chatSend,
    ),
  );

  const main = h(
    "div",
    { class: "room-main" },
    h("div", { class: "room-col room-col-roster" }, playersPanel, bansPanel, settingsPanel),
    h("div", { class: "room-col room-col-match" }, modePanel, mapPanel, managePanel),
    h("div", { class: "room-col room-col-chat" }, chatPanel),
  );
  // On phones the tab bar sits above the scroller (directly under the top bar), so the lobby header and panels scroll cleanly underneath it without ever peeking above the tabs. The dock stays fixed below the scroller.
  const content = h("main", { class: "room-content" }, header, notice, startNotice, joining, main);
  const root = h("div", { class: "room-screen", "data-tab": "players" }, tabBar, content, dock);

  // The reconnect banner floats over the top edge of the app. While it shows, the room's top padding starts below it (room.css), so no content scrolls under it.
  const banner = document.querySelector<HTMLElement>(".reconnect-banner");
  const bannerSpace = (): void => {
    const bottom = banner && !banner.hidden ? banner.getBoundingClientRect().bottom : 0;
    root.style.setProperty("--reconnect-space", `${bottom > 0 ? bottom + 8 : 0}px`);
  };
  const bannerSize = new ResizeObserver(bannerSpace);
  if (banner) bannerSize.observe(banner);

  // Section builders. Each reads `st`, which is set before any render runs.

  function buildHeader(room: RoomState): Node[] {
    return [
      h(
        "div",
        { class: "room-heading" },
        h("h1", { class: "room-title" }, room.name),
        h("dl", { class: "room-facts" }, fact("Code", room.code), room.quick === null ? null : fact("Type", "Quick play")),
      ),
      h(
        "div",
        { class: "actions room-header-actions" },
        // the lobby opened from the match menu: the match keeps running behind it
        st.inMatch
          ? h("button", { type: "button", class: "room-btn", "data-focus-key": "back", onclick: () => ctx.store.set({ screen: "match" }) }, icon("arrow-left", 16), "Back to game")
          : null,
        h("button", { type: "button", class: "room-btn room-invite", "data-focus-key": "invite", title: "Copy invite link", disabled: st.reconnecting, onclick: () => void shareInvite() }, labelSwap([[icon("link", 16), "Invite"], [icon("check", 16), "Link copied"]])),
        st.replayReady
          ? h(
              "button",
              { type: "button", class: "room-btn", "data-focus-key": "save", onclick: () => void saveReplay().catch(toastError) },
              icon("download", 16),
              "Save replay",
            )
          : null,
        // the player's Settings, the same screen as the main menu's: the room stays connected behind it and Back returns here
        h("button", { type: "button", class: "room-btn", "data-focus-key": "settings", onclick: () => ctx.store.set({ screen: "settings" }) }, icon("settings", 16), "Settings"),
        h("button", { type: "button", class: "room-btn quiet", "data-focus-key": "leave", disabled: st.reconnecting, onclick: leave }, icon("log-out", 16), "Leave"),
      ),
    ];
  }

  /** Ids of players whose typing signal is recent, sorted. Part of the roster key so the roster refreshes when it changes. */
  function activeTypers(): number[] {
    const now = performance.now();
    return Object.entries(st.typing)
      .filter(([, at]) => now - at < TYPING_SHOW_MS)
      .map(([id]) => Number(id))
      .sort((a, b) => a - b);
  }

  function settingRow(def: SettingDef, value: unknown, host: boolean): HTMLElement {
    if (def.kind === "b") {
      const box = h("input", {
        type: "checkbox",
        role: "switch",
        checked: value === true,
        "data-focus-key": def.field,
        disabled: !host,
        onchange: () => setSetting(def, String(box.checked)),
      });
      return h("label", { class: "room-setting" }, h("span", { class: "room-setting-label" }, def.name), box);
    }
    const num = h("input", {
      type: "number",
      "data-focus-key": def.field,
      step: def.kind === "f" ? "any" : "1",
      value: show(value),
      disabled: !host,
      onchange: () => {
        if (num.value === "") num.value = show(value);
        else setSetting(def, num.value);
      },
    });
    return h("label", { class: "room-setting" }, h("span", { class: "room-setting-label" }, def.name), num);
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
      // Non-hosts already see the read-only Match limits above; don't repeat them inside More settings.
      if (!host && group === "Match") continue;
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
              h("span", { class: "room-setting-label" }, readOnlyLabel(key)),
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
          { class: "actions" },
          h("button", { type: "button", onclick: resetSettings }, "Reset settings"),
        ),
      );
    }
    // The match limits are read at a glance; the full list (editable for the host) sits behind the disclosure.
    const limits = SETTINGS.filter((d) => d.group === "Match");
    return [
      h(
        "dl",
        { class: "room-facts room-limits" },
        limits.map((def) => fact(def.name, show(room.settings[def.field]))),
      ),
      h(
        "details",
        {
          class: "room-all-settings",
          open: settingsOpen,
          ontoggle: (e: Event) => (settingsOpen = (e.currentTarget as HTMLDetailsElement).open),
        },
        h("summary", null, icon("settings", 16), "More settings"),
        nodes,
      ),
    ];
  }

  /** The dock's status line: only shows actionable info (guests waiting, or missing players to start). */
  function dockText(room: RoomState, host: boolean): string {
    if (room.starting || room.in_match) return "";
    if (!host) return "Waiting for host to start";
    const active = room.players.filter((p) => p.team !== TEAM_SPECTATOR).length;
    const missing = ROOM_MIN_PLAYERS - active;
    if (missing > 0) return `Waiting for ${missing} more ${missing === 1 ? "player" : "players"}`;
    return "";
  }

  function renderRoom(): void {
    const room = st.room;
    const inNotice = room !== null && room.in_match && !st.inMatch;
    const joinCode = st.pending?.kind === "room" ? st.pending.code : null;
    joining.hidden = joinCode === null;
    joiningText.textContent = joinCode === null ? "" : `Joining room ${joinCode}…`;
    tabBar.hidden = room === null;
    header.hidden = room === null;
    main.hidden = room === null;
    dock.hidden = room === null;
    notice.hidden = !inNotice;
    notice.textContent = inNotice ? "match in progress" : "";
    startNotice.hidden = room === null || !room.starting;
    if (room === null) return;

    const host = isHost();
    const mode = roomMode(room);
    lastMapName = room.map_name;
    previewRoomMap();
    renderHeader(JSON.stringify([room.name, room.code, room.quick === null, st.inMatch, st.replayReady, st.reconnecting]));
    renderStartNotice(String(host));
    startButton.hidden = !host;
    startButton.disabled = room.in_match || room.starting || st.reconnecting;
    dockStatus.textContent = dockText(room, host);
    refreshPlayers();
    renderMode(`${host}|${mode}`);
    mapName.textContent = room.map_name;
    renderMapInfo(JSON.stringify([room.map, host, st.account !== null, room.map === null ? null : ageText(room.map.created)]));
    managePanel.hidden = !host;
    renderManage(JSON.stringify([host, room.locked, room.in_match, st.reconnecting]));
    bansPanel.hidden = !host;
    renderBans(JSON.stringify([host, room.bans]));
    // a picker's list is built when it opens; while open it follows builtins, the current map and the mode
    if (closeMapPicker !== null) refreshMapList();
    if (closeModePicker !== null) refreshModeList();
    renderSettings(`${host}|${JSON.stringify(room.settings)}`);
  }

  /** The map picker's list: what it shows (the host's view, the load state, the built-ins and the current map). */
  function refreshMapList(): void {
    renderMapList(JSON.stringify([isHost(), mapsError, builtins?.length ?? -1, lastMapName]));
  }

  function refreshModeList(): void {
    renderModeList(String(st.room === null ? null : roomMode(st.room)));
  }

  function startNoticeNodes(host: boolean): Node[] {
    return [
      h("span", null, "Match starting"),
      ...(host ? [h("button", { type: "button", class: "room-btn room-btn-small", "data-focus-key": "abort", onclick: abortStart }, icon("x", 16), "Abort start")] : []),
    ];
  }

  function chatNode(line: ChatLine, host: boolean, filter: boolean): HTMLElement {
    // Other players' lines are masked when the viewer filters profanity; their own lines show as typed.
    const masked = line.from !== null && line.from !== st.myId && filter;
    return chatLine(line, st.myId, masked ? filterProfanity(line.text) : line.text, host ? playOnJukebox : null);
  }

  /**
   * Keeps the chat log in step with the chat list. New lines are appended; the log rebuilds when the viewer, the
   * host status or the profanity filter changed, or when the list no longer extends the lines already shown.
   */
  function renderChat(): void {
    const host = isHost();
    const filter = prefs.value.filterProfanity;
    const shown = shownChat;
    const sameView = shown !== null && shown.myId === st.myId && shown.host === host && shown.filter === filter;
    if (shown !== null && sameView && shown.list === st.chat) return;
    const extendsShown =
      shown !== null && sameView && shown.count <= st.chat.length && (shown.count === 0 || st.chat[shown.count - 1] === shown.last);
    shownChat = { list: st.chat, count: st.chat.length, last: st.chat[st.chat.length - 1] ?? null, myId: st.myId, host, filter };
    if (shown !== null && extendsShown) {
      chatLog.append(...st.chat.slice(shown.count).map((line) => chatNode(line, host, filter)));
    } else {
      chatLog.replaceChildren(...st.chat.map((line) => chatNode(line, host, filter)));
    }
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

  // The roster's friend controls need the viewer's relations; load them on entry.
  void loadFriends();

  // Typing signals expire on their own: refresh the roster when one does.
  const typingTimer = setInterval(refreshPlayers, TYPING_TICK_MS);
  const unsubPrefs = prefs.subscribe(renderChat);
  // The roster's action menu closes on an outside press or Escape.
  window.addEventListener("pointerdown", onMenuOutside, true);
  window.addEventListener("keydown", onMenuKey);

  return {
    el: root,
    update(next, prev) {
      st = next;
      bannerSpace();
      if (next.account !== prev.account) void loadFriends();
      if (
        next.pending !== prev.pending ||
        next.room !== prev.room ||
        next.myId !== prev.myId ||
        next.inMatch !== prev.inMatch ||
        next.replayReady !== prev.replayReady ||
        next.reconnecting !== prev.reconnecting ||
        next.account !== prev.account
      ) {
        renderRoom();
      } else if (next.typing !== prev.typing) {
        refreshPlayers();
      }
      renderChat();
      // The room's server-bound actions wait for the connection: they are disabled, not silently dropped, while it is restored.
      syncChatSend(next.reconnecting);
    },
    destroy() {
      alive = false;
      clearInterval(typingTimer);
      bannerSize.disconnect();
      unsubPrefs();
      closeVoteMenu();
      window.removeEventListener("pointerdown", onMenuOutside, true);
      window.removeEventListener("keydown", onMenuKey);
      closeLibrary?.();
      closeLibrary = null;
      closePicker?.();
      closePicker = null;
    },
  };
};
