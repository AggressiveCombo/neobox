// Application shell: owns the services, the connection state machine and screen
// mounting. Screens render from the store; this file reacts to server messages.

import { fetchBuiltinMaps, wsUrl, type BuiltinMap } from "./api";
import { Sfx } from "./audio";
import { computeCamera, findLocal } from "./camera";
import type { AppCtx, HudHandle, Present, ScreenFactory, ScreenHandle, WasmTools } from "./ctx";
import { Engine, loadWasmEngine } from "./engine";
import { readScene } from "./frame";
import { MatchLoop, type SnapshotBytes } from "./game";
import { Input } from "./input";
import { Net, type NetStatus } from "./net";
import { NAME_RE, PROTOCOL_VERSION, type MatchStart, type RoomState, type ServerMsg } from "./protocol";
import { createRenderer, type Renderer } from "./render";
import { Overlay } from "./render/overlay";
import { CHAT_LIMIT, NAME_STORAGE_KEY, SEAT_STORAGE_KEY, Store, initialState, type AppState, type ChatLine, type Screen } from "./state";
import { aboutScreen } from "./ui/screens/about";
import { browserScreen } from "./ui/screens/browser";
import { hudScreen } from "./ui/screens/hud";
import { menuScreen } from "./ui/screens/menu";
import { roomScreen } from "./ui/screens/room";
import { practiceScreen } from "./ui/screens/practice";
import { settingsScreen } from "./ui/screens/settings";
import { replayScreen } from "./ui/screens/replay";
import { startAccountSync } from "./account";
import { accountScreen } from "./ui/screens/account";
import { friendsScreen } from "./ui/screens/friends";
import { libraryScreen } from "./ui/screens/library";
import { editorScreen } from "./ui/screens/editor";
import { h } from "./ui/dom";
import { showToast } from "./ui/toast";

const SCREEN_FACTORIES: Record<Exclude<Screen, "match">, ScreenFactory> = {
  menu: menuScreen,
  about: aboutScreen,
  browse: browserScreen,
  room: roomScreen,
  replay: replayScreen,
  settings: settingsScreen,
  practice: practiceScreen,
  account: accountScreen,
  friends: friendsScreen,
  library: libraryScreen,
  editor: editorScreen,
};

/** Room codes: 6 characters from the server's alphabet (no I, O, 0 or 1). */
const ROOM_CODE_RE = /^[A-HJ-NP-Z2-9]{6}$/;
/** Delays before each reconnect attempt after an unexpected drop; the last one repeats. */
const RECONNECT_DELAYS_MS = [500, 1000, 2000, 4000, 8000];
/** Stop retrying this long after the first drop. */
const RECONNECT_GIVE_UP_MS = 60_000;
/** Close reasons the server sends when it removes us from the room; the kick message already says so. */
const REMOVED_REASONS = new Set(["kicked", "banned"]);

function byId<T extends HTMLElement>(id: string): T {
  const el = document.getElementById(id);
  if (!el) throw new Error(`missing #${id}`);
  return el as T;
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function appendChat(chat: ChatLine[], line: ChatLine): ChatLine[] {
  const next = [...chat, line];
  return next.length > CHAT_LIMIT ? next.slice(next.length - CHAT_LIMIT) : next;
}

/** Decode the base64 snapshot state from a `snapshot` message. */
function decodeSnapshot(state: string): Uint8Array {
  return Uint8Array.from(atob(state), (c) => c.charCodeAt(0));
}

/** A room code given as `/CODE` or `?room=CODE` (invite links), or null. */
function inviteFromUrl(): string | null {
  const fromQuery = new URLSearchParams(location.search).get("room");
  const fromPath = location.pathname.replace(/^\/+|\/+$/g, "");
  const code = (fromQuery ?? fromPath).trim().toUpperCase();
  return ROOM_CODE_RE.test(code) ? code : null;
}

/** Keep the address bar on `/CODE` while in a room (shareable, reload rejoins), `/` otherwise. */
function syncUrl(code: string | null): void {
  const want = code === null ? "/" : `/${code}`;
  if (location.pathname !== want || location.search !== "") history.replaceState(null, "", want);
}

export function start(): void {
  const store = new Store<AppState>(initialState());
  const input = new Input();
  const sfx = new Sfx();
  const overlay = new Overlay(byId<HTMLCanvasElement>("overlay"));
  const glHost = byId("gl-host");
  const uiRoot = byId("ui");
  const toastHost = byId("toasts");

  let engine: Engine | null = null;
  let renderer: Renderer | null = null;
  let rendererP: Promise<void> | null = null;
  let mapsP: Promise<BuiltinMap[]> | null = null;
  let pendingName: string | null = null;
  /** Room to join once the server has welcomed us (invite links, friends). */
  let pendingJoin: string | null = null;
  /** The room we are in and its resume token (from `joined`); kept across a dropped connection. */
  let roomCode: string | null = null;
  let resumeToken: string | null = null;
  /** The room of the last join_room we sent: a refused join names the room that needs a password. */
  let joinAttempt: string | null = null;
  /** A resume join is in flight after a reconnect. */
  let resuming = false;
  let reconnectTimer: number | null = null;
  let reconnectSince = 0;
  let reconnectAttempt = 0;
  let mounted: Screen | null = null;
  let current: ScreenHandle | null = null;
  let hud: HudHandle | null = null;
  let loop: MatchLoop | null = null;
  let namesRoom: RoomState | null = null;
  let namesMap = new Map<number, string>();

  const toast = (text: string, kind: "info" | "error" = "info"): void => showToast(toastHost, text, kind);

  function needEngine(): Engine {
    if (!engine) throw new Error("engine not loaded");
    return engine;
  }

  // The menu mounts immediately; the engine loads in the background.
  const engineP: Promise<Engine> = loadWasmEngine().then((raw) => {
    engine = new Engine(raw);
    return engine;
  });
  engineP.catch((err: unknown) => toast(`engine failed to load: ${errText(err)}`, "error"));

  /** Draw the engine's current frame buffer (built by a match, replay or local game). */
  const present: Present = (names, tickHz) => {
    const fb = engine?.framebuffer();
    if (!fb) return null;
    ensureRenderer();
    const scene = readScene(fb);
    const cam = computeCamera(scene, window.innerWidth, window.innerHeight, findLocal(scene));
    renderer?.draw(scene, cam);
    overlay.draw(scene, cam, names, tickHz);
    for (const s of scene.sounds) sfx.play(s.kind, s.volume);
    return scene;
  };

  const wasm: WasmTools = {
    mapPreview: (code) => needEngine().mapPreview(code),
    mapEncode: (json) => needEngine().mapEncode(json),
  };

  const net = new Net({
    onMessage: (msg) => handleServer(msg),
    onBinary: (bytes) => loop?.onServer(bytes),
    onStatus: (status, detail, unexpected) => onStatus(status, detail, unexpected ?? false),
  });

  const ctx: AppCtx = {
    store,
    net,
    input,
    sfx,
    wasm,
    engine: () => engineP,
    present,
    send: (msg) => {
      if (msg.t === "join_room") joinAttempt = msg.room;
      net.send(msg);
    },
    toast,
    play,
    joinRoom,
    disconnect,
    maps: () => {
      if (!mapsP) {
        mapsP = fetchBuiltinMaps().catch((err: unknown) => {
          mapsP = null;
          throw err;
        });
      }
      return mapsP;
    },
  };

  startAccountSync(ctx);

  /** Mount a screen factory's output, replacing whatever is shown. */
  function mount(screen: Screen): void {
    current?.destroy();
    hud = null;
    let handle: ScreenHandle;
    if (screen === "match") {
      const hudHandle = hudScreen(ctx);
      hud = hudHandle;
      handle = hudHandle;
    } else {
      handle = SCREEN_FACTORIES[screen](ctx);
    }
    current = handle;
    mounted = screen;
    uiRoot.replaceChildren(handle.el);
  }

  store.subscribe((state, prev) => {
    if (state.screen !== mounted) mount(state.screen);
    current?.update(state, prev);
  });

  // Shown over every screen while the connection to a room is being restored.
  const banner = h(
    "div",
    { class: "reconnect-banner", role: "status", "aria-live": "polite" },
    h("span", null, "Connection lost. Reconnecting…"),
    h("button", { type: "button", onclick: () => disconnect() }, "Leave"),
  );
  banner.hidden = true;
  document.body.append(banner);
  store.subscribe((state) => {
    banner.hidden = !state.reconnecting;
  });

  function names(): ReadonlyMap<number, string> {
    const room = store.state.room;
    if (room !== namesRoom) {
      namesRoom = room;
      namesMap = new Map((room?.players ?? []).map((p): [number, string] => [p.id, p.name]));
    }
    return namesMap;
  }

  /** Renderer creation is async (WebGPU or WebGL2 init); the loop skips drawing until it is ready. */
  function ensureRenderer(): void {
    if (renderer || rendererP) return;
    rendererP = createRenderer(glHost, onRendererLost).then(
      (r) => {
        renderer = r;
        document.documentElement.dataset.renderer = r.kind;
        resizeAll();
      },
      (err: unknown) => {
        rendererP = null;
        toast(`graphics unavailable: ${errText(err)}`, "error");
      },
    );
  }

  function onRendererLost(): void {
    renderer?.destroy();
    renderer = null;
    rendererP = null;
    toast("graphics context lost", "error");
    if (store.state.inMatch) ensureRenderer();
  }

  function resizeAll(): void {
    const dpr = window.devicePixelRatio || 1;
    const w = Math.round(window.innerWidth * dpr);
    const hPx = Math.round(window.innerHeight * dpr);
    renderer?.resize(w, hPx);
    overlay.resize(w, hPx);
  }

  /** This tab's seat, kept in sessionStorage so a page reload rejoins the same slot. */
  function saveSeat(): void {
    try {
      if (roomCode !== null && resumeToken !== null) {
        window.sessionStorage.setItem(SEAT_STORAGE_KEY, JSON.stringify({ room: roomCode, token: resumeToken }));
      } else {
        window.sessionStorage.removeItem(SEAT_STORAGE_KEY);
      }
    } catch {
      // Storage blocked: a reload joins as a new player.
    }
  }

  /** The resume token this tab holds for `room`, if any. */
  function seatToken(room: string): string | null {
    try {
      const seat: unknown = JSON.parse(window.sessionStorage.getItem(SEAT_STORAGE_KEY) ?? "null");
      if (typeof seat !== "object" || seat === null || !("room" in seat) || !("token" in seat)) return null;
      return seat.room === room && typeof seat.token === "string" ? seat.token : null;
    } catch {
      return null;
    }
  }

  /** Back to the main menu, forgetting the room and any reconnect in progress. */
  function resetToMenu(): void {
    stopReconnect();
    roomCode = null;
    resumeToken = null;
    saveSeat();
    store.set({
      screen: "menu",
      myId: null,
      serverName: "",
      rooms: [],
      room: null,
      chat: [],
      inMatch: false,
      tickHz: 0,
      showScores: false,
      replayReady: false,
      intent: null,
      invite: null,
    });
    syncUrl(null);
  }

  /** Leave the current room (server said so, or the player did) and show the browser. */
  function leaveRoom(): void {
    loop?.stop();
    roomCode = null;
    resumeToken = null;
    saveSeat();
    stopReconnect();
    store.set({
      room: null,
      chat: [],
      inMatch: false,
      tickHz: 0,
      showScores: false,
      replayReady: false,
      screen: "browse",
    });
    syncUrl(null);
  }

  function startMatch(match: MatchStart, you: number | null, snap: SnapshotBytes | null): void {
    const eng = engine;
    if (!eng) {
      toast("engine not loaded", "error");
      return;
    }
    ensureRenderer();
    loop ??= new MatchLoop({
      engine: eng,
      input,
      net,
      store,
      present,
      hud: () => hud,
      names,
      onError: (message) => {
        toast(`match stopped: ${message}`, "error");
        store.set({ inMatch: false, tickHz: 0, screen: store.state.room ? "room" : "browse" });
      },
    });
    try {
      loop.begin(match, you ?? -1, snap);
    } catch (err) {
      toast(`match failed: ${errText(err)}`, "error");
      return;
    }
    store.set({ inMatch: true, tickHz: match.tick_hz, screen: "match", showScores: false, replayReady: false });
  }

  function sendJoin(room: string, password: string | null): void {
    joinAttempt = room;
    net.send({ t: "join_room", room, password, resume: seatToken(room) });
  }

  function handleServer(msg: ServerMsg): void {
    switch (msg.t) {
      case "welcome": {
        // A reconnect rejoins the room with its resume token; the screen stays where it was.
        if (store.state.reconnecting && roomCode !== null && resumeToken !== null) {
          resuming = true;
          net.send({ t: "join_room", room: roomCode, password: null, resume: resumeToken });
          return;
        }
        const quick = store.state.intent === "quick";
        store.set({ serverName: msg.server, screen: "browse", intent: null });
        net.send({ t: "list_rooms" });
        if (pendingJoin !== null) {
          sendJoin(pendingJoin, null);
          pendingJoin = null;
        } else if (quick) {
          net.send({ t: "quick_play" });
        }
        return;
      }
      case "joined":
        resumeToken = msg.token;
        store.set({ myId: msg.you });
        if (resuming || store.state.reconnecting) {
          resuming = false;
          stopReconnect();
        }
        return;
      case "error":
        if (resuming) {
          resuming = false;
          leaveRoom();
          net.send({ t: "list_rooms" });
          toast(`could not rejoin the room: ${msg.message}`, "error");
          return;
        }
        if (msg.code === "wrong_password" && joinAttempt !== null) store.set({ invite: joinAttempt });
        toast(msg.message, "error");
        return;
      case "rooms":
        store.set({ rooms: msg.rooms });
        return;
      case "room": {
        const chat = store.state.room?.code === msg.room.code ? store.state.chat : [];
        roomCode = msg.room.code;
        saveSeat();
        syncUrl(roomCode);
        store.set({
          room: msg.room,
          chat,
          invite: null,
          screen: store.state.inMatch ? store.state.screen : "room",
        });
        return;
      }
      case "left":
        leaveRoom();
        net.send({ t: "list_rooms" });
        return;
      case "kicked":
        toast(`kicked: ${msg.reason}`, "error");
        leaveRoom();
        net.send({ t: "list_rooms" });
        return;
      case "chat":
        if (msg.from !== null && msg.from !== store.state.myId) sfx.chatPop();
        store.set({ chat: appendChat(store.state.chat, { from: msg.from, name: msg.name, text: msg.text }) });
        return;
      case "match_start":
        startMatch(msg.start, msg.you, null);
        return;
      case "snapshot":
        startMatch(msg.start, msg.you, { tick: msg.tick, bytes: decodeSnapshot(msg.state), held: msg.held });
        return;
      case "match_end":
        loop?.stop();
        store.set({ inMatch: false, tickHz: 0, showScores: false, replayReady: true, screen: "room" });
        return;
      case "tick_rate":
        store.set({ tickHz: msg.tick_hz });
        return;
      case "rtc_answer":
        // Consumed by Net before it reaches the app.
        return;
    }
  }

  function stopReconnect(): void {
    if (reconnectTimer !== null) window.clearTimeout(reconnectTimer);
    reconnectTimer = null;
    reconnectAttempt = 0;
    resuming = false;
    if (store.state.reconnecting) store.set({ reconnecting: false });
  }

  function connectForResume(): void {
    if (net.status === "closed") net.connect(wsUrl());
  }

  /** Schedule the next attempt, or give up once the deadline has passed. */
  function scheduleReconnect(): void {
    if (reconnectTimer !== null) window.clearTimeout(reconnectTimer);
    reconnectTimer = null;
    if (performance.now() - reconnectSince >= RECONNECT_GIVE_UP_MS) {
      resetToMenu();
      toast("could not reconnect to the room", "error");
      return;
    }
    const delay = RECONNECT_DELAYS_MS[Math.min(reconnectAttempt, RECONNECT_DELAYS_MS.length - 1)];
    reconnectAttempt++;
    reconnectTimer = window.setTimeout(() => {
      reconnectTimer = null;
      connectForResume();
    }, delay);
  }

  /** The socket dropped while in a room: show the banner and retry with the resume token. */
  function beginReconnect(): void {
    if (!store.state.reconnecting) {
      reconnectSince = performance.now();
      reconnectAttempt = 0;
      store.set({ reconnecting: true, inMatch: false, tickHz: 0, showScores: false, screen: "room" });
    }
    scheduleReconnect();
  }

  /** Retry now (instead of waiting out the backoff) when the page is shown again or the network returns. */
  function retryNow(): void {
    if (!store.state.reconnecting || net.status !== "closed") return;
    if (reconnectTimer !== null) window.clearTimeout(reconnectTimer);
    reconnectTimer = null;
    connectForResume();
  }

  function onStatus(status: NetStatus, detail: string | undefined, unexpected: boolean): void {
    store.set({ connection: status, connectDetail: detail ?? "" });
    if (status === "open") {
      const name = pendingName ?? (store.state.reconnecting ? store.state.name : null);
      pendingName = null;
      if (name !== null) net.send({ t: "hello", version: PROTOCOL_VERSION, name });
      return;
    }
    if (status !== "closed") return;
    loop?.stop();
    if (unexpected && roomCode !== null && resumeToken !== null) {
      beginReconnect();
      return;
    }
    resetToMenu();
    if (detail && !REMOVED_REASONS.has(detail)) toast(detail, "error");
  }

  /** Connect if needed, then say hello with `name`. The welcome message moves the app to the browser. */
  function play(name: string): void {
    store.set({ name });
    window.localStorage.setItem(NAME_STORAGE_KEY, name);
    if (net.status === "open") {
      net.send({ t: "hello", version: PROTOCOL_VERSION, name });
      return;
    }
    pendingName = name;
    if (net.status === "closed") net.connect(wsUrl());
  }

  /** Join room `code`: right away when connected, else after connecting with the saved name (or from the menu). */
  function joinRoom(code: string): void {
    if (net.status === "open" && store.state.serverName !== "") {
      sendJoin(code, null);
      return;
    }
    pendingJoin = code;
    const name = store.state.account?.name ?? (store.state.name || window.localStorage.getItem(NAME_STORAGE_KEY) || "");
    if (NAME_RE.test(name)) play(name);
    else store.set({ screen: "menu" });
  }

  /** Close the connection and return to the main menu. */
  function disconnect(): void {
    loop?.stop();
    pendingName = null;
    pendingJoin = null;
    net.close();
    resetToMenu();
  }

  input.onKey = (code, down) => {
    if (code === "F3" && down) store.set({ showStats: !store.state.showStats });
    else if (code === "Tab") store.set({ showScores: down && store.state.inMatch });
  };

  window.addEventListener("keydown", (e) => {
    if (e.code === "F3") e.preventDefault();
  });
  window.addEventListener("pointerdown", () => sfx.unlock());
  window.addEventListener("keydown", () => sfx.unlock());
  window.addEventListener("resize", resizeAll);
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) retryNow();
  });
  window.addEventListener("online", retryNow);

  mount(store.state.screen);
  const boot = document.getElementById("boot");
  if (boot) boot.hidden = true;

  const invite = inviteFromUrl();
  if (invite !== null) joinRoom(invite);
}
